/**
 * File: server/modules/billing/subscription.service.ts
 * Purpose: 订阅同步统一服务 —— Billing callback 和 Webhook 共用同一套核心处理逻辑。
 *          从 Shopify 侧查询当前活跃订阅，映射到本地 billing_subscription，
 *          幂等地创建/更新订阅记录，避免重复发放额度。
 *
 * ### 设计要点
 * - 幂等：通过 externalSubscriptionId 唯一约束保证重复处理不会重复创建记录。
 * - 统一入口：callback / webhook / 手动同步均调用 syncSubscriptionFromShopify()。
 * - 无额度发放：订阅同步仅更新订阅状态，额度发放由独立的 grant-credit 流程负责。
 */
import { createLogger } from '../../utils/logger.js';
import { decryptToken } from '../../crypto/token-encryption.js';
import { getBillingAdapter } from '../../shopify/billing-adapter.js';
import { getPlanConfig } from './plan-config.js';
import { isValidPlanKey } from './plan-config.js';
// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------
const log = createLogger({ module: 'subscription-service' });
// ----------------------------------------------------------------------------
// Shopify → 本地映射
// ----------------------------------------------------------------------------
/**
 * Shopify 订阅名称 → PlanKey 映射。
 * 名称格式为 "Starter Monthly" / "Growth Annual" 等。
 */
function mapNameToPlanKey(name) {
    const upper = name.toUpperCase();
    if (upper.includes('MAX'))
        return 'MAX';
    if (upper.includes('PRO'))
        return 'PRO';
    if (upper.includes('GROWTH'))
        return 'GROWTH';
    if (upper.includes('STARTER'))
        return 'STARTER';
    return 'FREE';
}
/**
 /**
  * Shopify interval → Prisma BillingInterval 映射。
  * 注意：Prisma BillingInterval 枚举包含 NONE（用于 FREE 计划）。
  */
function mapInterval(interval) {
    if (interval === 'ANNUAL')
        return 'ANNUAL';
    if (interval === 'EVERY_30_DAYS')
        return 'MONTHLY';
    return 'NONE';
}
/**
 * Shopify 状态 → 本地 BillingSubscriptionStatus 映射。
 */
function mapStatus(status) {
    switch (status) {
        case 'ACTIVE':
        case 'ACCEPTED':
            return 'ACTIVE';
        case 'CANCELLED':
            return 'CANCELED';
        case 'EXPIRED':
            return 'EXPIRED';
        case 'FROZEN':
            return 'ACTIVE'; // FROZEN 仍视为活跃，暂停计费但保留订阅
        case 'DECLINED':
            return 'FAILED';
        default:
            return 'FAILED';
    }
}
/**
 * 计算当前周期截止时间。
 * - 月付：当月最后一天 23:59:59 UTC
 * - 年付：当年最后一天 23:59:59 UTC
 */
function computePeriodEnd(start, interval) {
    if (interval === 'ANNUAL') {
        return new Date(Date.UTC(start.getUTCFullYear(), 11, 31, 23, 59, 59));
    }
    // 月付：下月第一天减 1 秒
    return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0, 23, 59, 59));
}
/**
 * 将 Shopify ActiveSubscription 映射为本地 MappedSubscription。
 */
function mapShopifySubscription(sub) {
    const planKey = mapNameToPlanKey(sub.name);
    const interval = mapInterval(sub.interval);
    const config = getPlanConfig(planKey);
    const now = new Date();
    const periodEnd = computePeriodEnd(now, interval);
    return {
        planKey,
        interval,
        status: mapStatus(sub.status),
        externalSubscriptionId: sub.id,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        incrementalScanEnabled: config.incrementalScanEnabled,
    };
}
// ----------------------------------------------------------------------------
// 核心服务：从 Shopify 同步订阅状态
// ----------------------------------------------------------------------------
/**
 * 从 Shopify 同步订阅状态到本地。
 *
 * ### 流程
 * 1. 查找 shop（含加密 access token）
 * 2. 通过 Billing Adapter 查询 Shopify 当前活跃订阅
 * 3. 将 Shopify 订阅映射为本地模型
 * 4. 根据 externalSubscriptionId 查找本地记录
 *    - 已存在且状态不变 → 无操作（幂等）
 *    - 已存在但状态变化 → 更新
 *    - 不存在 → 创建，停用旧的活跃订阅
 * 5. 更新 shop.currentPlan
 *
 * @param shopDomain  店铺域名
 * @param adapter     可选 BillingAdapter（默认使用工厂单例）
 * @param client      可选 PrismaClient（默认使用全局单例）
 */
export async function syncSubscriptionFromShopify(shopDomain, adapter, client) {
    if (!shopDomain) {
        throw new Error('[subscription-service] shopDomain 不能为空');
    }
    // 懒加载依赖
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
    const db = client ?? (await import('../../db/prisma.server.js')).default;
    const billingAdapter = adapter ?? getBillingAdapter();
    // ---- 1. 查找 shop ----
    const shop = await db.shop.findUnique({
        where: { shopDomain },
        select: {
            id: true,
            shopDomain: true,
            currentPlan: true,
            accessTokenEncrypted: true,
            accessTokenNonce: true,
            accessTokenTag: true,
        },
    });
    if (!shop) {
        throw new Error(`[subscription-service] Shop not found: ${shopDomain}`);
    }
    log.info({ shopId: shop.id, shopDomain }, '开始从 Shopify 同步订阅状态');
    // ---- 2. 查询 Shopify 侧订阅 ----
    const accessToken = decryptToken(shop.accessTokenEncrypted, shop.accessTokenNonce, shop.accessTokenTag);
    const subsResult = await billingAdapter.getCurrentAppSubscriptions({
        shop: shopDomain,
        accessToken,
    });
    if (!subsResult.success) {
        throw new Error(`[subscription-service] 查询 Shopify 订阅失败: ${subsResult.errorMessage ?? 'Unknown'}`);
    }
    // ---- 3. 找到第一个 ACTIVE 状态的 Shopify 订阅 ----
    const activeSub = subsResult.subscriptions.find((s) => s.status === 'ACTIVE' || s.status === 'ACCEPTED' || s.status === 'FROZEN');
    if (!activeSub) {
        // Shopify 侧无活跃订阅 → 可能已全部取消
        log.info({ shopId: shop.id }, 'Shopify 侧无活跃订阅，保持本地现状');
        // 不做降级处理（降级由 changePlanToFree 统一管理）
        const localActive = await db.billingSubscription.findFirst({
            where: { shopId: shop.id, status: 'ACTIVE' },
            select: { id: true, planCode: true, status: true },
        });
        return {
            created: false,
            changed: false,
            subscriptionId: localActive?.id ?? '',
            planCode: localActive?.planCode ?? 'FREE',
            status: localActive?.status ?? 'ACTIVE',
        };
    }
    // ---- 4. 映射 Shopify 订阅到本地模型 ----
    const mapped = mapShopifySubscription(activeSub);
    // 校验 planKey 合法性
    if (!isValidPlanKey(mapped.planKey)) {
        log.warn({ shopId: shop.id, subName: activeSub.name, mappedPlan: mapped.planKey }, '无法映射 Shopify 订阅名称到本地计划，跳过');
        const localActive = await db.billingSubscription.findFirst({
            where: { shopId: shop.id, status: 'ACTIVE' },
            select: { id: true, planCode: true, status: true },
        });
        return {
            created: false,
            changed: false,
            subscriptionId: localActive?.id ?? '',
            planCode: localActive?.planCode ?? 'FREE',
            status: localActive?.status ?? 'ACTIVE',
        };
    }
    log.info({
        shopId: shop.id,
        externalId: mapped.externalSubscriptionId,
        planKey: mapped.planKey,
        interval: mapped.interval,
        status: mapped.status,
    }, 'Shopify 订阅映射完成');
    // ---- 5. 查找本地已有记录（通过 externalSubscriptionId 幂等） ----
    const existing = await db.billingSubscription.findUnique({
        where: { externalSubscriptionId: mapped.externalSubscriptionId },
        select: { id: true, status: true, planCode: true },
    });
    if (existing) {
        // 已存在：检查状态是否变化
        if (existing.status === mapped.status && existing.planCode === mapped.planKey) {
            log.info({ shopId: shop.id, subscriptionId: existing.id }, '订阅已存在且状态一致，跳过（幂等）');
            return {
                created: false,
                changed: false,
                subscriptionId: existing.id,
                planCode: mapped.planKey,
                status: mapped.status,
            };
        }
        // 状态变化：更新
        await db.billingSubscription.update({
            where: { id: existing.id },
            data: {
                status: mapped.status,
                planCode: mapped.planKey,
                billingInterval: mapped.interval,
                currentPeriodStart: mapped.currentPeriodStart,
                currentPeriodEnd: mapped.currentPeriodEnd,
                incrementalScanEnabled: mapped.incrementalScanEnabled,
                ...(mapped.status === 'CANCELED' ? { canceledAt: new Date() } : {}),
                ...(mapped.status === 'ACTIVE' ? { activatedAt: new Date() } : {}),
            },
        });
        // 更新 shop.currentPlan
        await db.shop.update({
            where: { id: shop.id },
            data: { currentPlan: mapped.planKey },
        });
        log.info({ shopId: shop.id, subscriptionId: existing.id, newStatus: mapped.status }, '订阅状态更新完成');
        return {
            created: false,
            changed: true,
            subscriptionId: existing.id,
            planCode: mapped.planKey,
            status: mapped.status,
        };
    }
    // ---- 6. 新订阅：停用旧活跃订阅 + 创建新订阅 + 更新 shop ----
    const now = new Date();
    const result = await db.$transaction(async (tx) => {
        // 6a. 停用旧的活跃订阅
        const oldSubs = await tx.billingSubscription.findMany({
            where: { shopId: shop.id, status: 'ACTIVE' },
            select: { id: true },
        });
        for (const old of oldSubs) {
            await tx.billingSubscription.update({
                where: { id: old.id },
                data: {
                    status: 'CANCELED',
                    canceledAt: now,
                },
            });
        }
        // 6b. 创建新订阅
        const newSub = await tx.billingSubscription.create({
            data: {
                shopId: shop.id,
                planCode: mapped.planKey,
                billingInterval: mapped.interval,
                status: mapped.status,
                externalSubscriptionId: mapped.externalSubscriptionId,
                currentPeriodStart: mapped.currentPeriodStart,
                currentPeriodEnd: mapped.currentPeriodEnd,
                incrementalScanEnabled: mapped.incrementalScanEnabled,
                activatedAt: now,
            },
            select: { id: true },
        });
        // 6c. 更新 shop.currentPlan
        await tx.shop.update({
            where: { id: shop.id },
            data: { currentPlan: mapped.planKey },
        });
        return { subscriptionId: newSub.id, deactivatedCount: oldSubs.length };
    });
    log.info({
        shopId: shop.id,
        subscriptionId: result.subscriptionId,
        planKey: mapped.planKey,
        deactivatedCount: result.deactivatedCount,
    }, '新订阅创建完成，旧订阅已停用');
    return {
        created: true,
        changed: true,
        subscriptionId: result.subscriptionId,
        planCode: mapped.planKey,
        status: mapped.status,
    };
}
