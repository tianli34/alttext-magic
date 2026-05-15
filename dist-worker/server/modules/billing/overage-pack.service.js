/**
 * File: server/modules/billing/overage-pack.service.ts
 * Purpose: 超额包购买与发放服务。
 *
 * ### 流程
 * 1. initiateOveragePackPurchase: 发起购买
 *    - 校验超额包配置与当前计划
 *    - 创建 PENDING overage_pack_purchase 记录
 *    - 调用 Shopify createOneTimePurchase
 *    - 记录 externalPurchaseId
 *    - 返回 confirmationUrl
 *
 * 2. fulfillOveragePackPurchase: 确认并发放（幂等）
 *    - 查找 PENDING 购买记录
 *    - 幂等检查：已 PURCHASED 直接返回
 *    - 更新状态为 PURCHASED
 *    - 创建 OVERAGE_PACK bucket + GRANT ledger（通过 grantCreditBucket）
 *
 * ### 幂等保证
 * - purchase callback 重复调用不会重复发放（状态检查 + bucket 唯一约束双重保障）
 * - grantCreditBucket 自身通过 (shopId, bucketType, cycleKey) 唯一约束保证幂等
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../utils/logger.js';
import { decryptToken } from '../../crypto/token-encryption.js';
import { getPlanConfig } from './plan-config.js';
import { grantCreditBucket } from './credit/grant-credit.server.js';
// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------
const log = createLogger({ module: 'overage-pack-service' });
// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------
/**
 * 在指定计划的超额包配置中查找匹配项。
 * @returns 匹配的超额包配置，未找到返回 null
 */
export function findOveragePackConfig(planKey, packCode) {
    const config = getPlanConfig(planKey);
    return config.overagePacks.find((p) => p.packCode === packCode) ?? null;
}
// ----------------------------------------------------------------------------
// 发起超额包购买
// ----------------------------------------------------------------------------
/**
 * 发起超额包购买。
 *
 * 1. 校验 packCode 对应当前计划的超额包配置
 * 2. 创建 PENDING overage_pack_purchase 记录
 * 3. 调用 Shopify Billing Adapter createOneTimePurchase
 * 4. 记录 externalPurchaseId
 * 5. 返回 confirmationUrl
 *
 * @param params   购买参数
 * @param adapter  BillingAdapter 实例
 * @param client   PrismaClient 实例
 */
export async function initiateOveragePackPurchase(params, adapter, client) {
    const { shopId, shopDomain, accessTokenEncrypted, accessTokenNonce, accessTokenTag, currentPlan, packCode, returnUrl, } = params;
    // ---- 1. 校验超额包配置 ----
    const packConfig = findOveragePackConfig(currentPlan, packCode);
    if (!packConfig) {
        throw new Error(`[overage-pack] 计划 ${currentPlan} 不支持超额包 ${packCode}`);
    }
    // ---- 2. 解密 access token ----
    const accessToken = decryptToken(accessTokenEncrypted, accessTokenNonce, accessTokenTag);
    // ---- 3. 查找当前活跃订阅（可选关联） ----
    const activeSubscription = await client.billingSubscription.findFirst({
        where: { shopId, status: 'ACTIVE' },
        select: { id: true },
    });
    // ---- 4. 创建 PENDING overage_pack_purchase 记录 ----
    const idempotencyKey = `OVERAGE_PURCHASE:${randomUUID()}`;
    const purchase = await client.overagePackPurchase.create({
        data: {
            shopId,
            billingSubscriptionId: activeSubscription?.id ?? null,
            status: 'PENDING',
            packCode,
            grantedAmount: packConfig.credits,
            priceCents: packConfig.priceCents,
            currencyCode: 'USD',
            idempotencyKey,
        },
    });
    log.info({ shopId, packCode, purchaseId: purchase.id }, '创建 PENDING 超额包购买记录');
    // ---- 5. 构造包含购买 ID 的回调 URL ----
    const separator = returnUrl.includes('?') ? '&' : '?';
    const callbackUrl = `${returnUrl}${separator}purchaseId=${purchase.id}`;
    // ---- 6. 调用 Shopify Billing Adapter ----
    const result = await adapter.createOneTimePurchase({
        shop: shopDomain,
        accessToken,
        packKey: packCode,
        returnUrl: callbackUrl,
        packName: `Overage Pack ${packConfig.credits}`,
        priceCents: packConfig.priceCents,
    });
    if (!result.success || !result.confirmationUrl) {
        // 购买创建失败 → 标记 FAILED
        await client.overagePackPurchase.update({
            where: { id: purchase.id },
            data: { status: 'FAILED' },
        });
        log.error({ shopId, packCode, purchaseId: purchase.id, error: result.errorMessage }, 'Shopify 购买创建失败');
        throw new Error(`[overage-pack] Shopify 购买创建失败: ${result.errorMessage ?? 'unknown'}`);
    }
    // ---- 7. 记录 externalPurchaseId + purchasedAt ----
    await client.overagePackPurchase.update({
        where: { id: purchase.id },
        data: {
            externalPurchaseId: result.purchaseId ?? null,
            purchasedAt: new Date(),
        },
    });
    log.info({
        shopId,
        packCode,
        purchaseId: purchase.id,
        externalPurchaseId: result.purchaseId,
    }, '超额包购买已发起，等待用户确认');
    return {
        confirmationUrl: result.confirmationUrl,
        purchaseId: purchase.id,
        externalPurchaseId: result.purchaseId ?? '',
    };
}
// ----------------------------------------------------------------------------
// 确认超额包购买并发放额度（幂等）
// ----------------------------------------------------------------------------
/**
 * 确认超额包购买并发放额度。
 *
 * ### 幂等保证
 * - 如果购买状态已为 PURCHASED，直接返回（不重复发放）
 * - grantCreditBucket 通过 (shopId, bucketType, cycleKey) 唯一约束保证幂等
 *
 * ### cycleKey 格式
 * `OVERAGE:{externalPurchaseId}`
 * 若 externalPurchaseId 为空则回退到内部 purchase ID
 *
 * @param purchaseId  内部购买记录 ID
 * @param client      PrismaClient 实例
 */
export async function fulfillOveragePackPurchase(purchaseId, client) {
    // ---- 1. 查找购买记录 ----
    const purchase = await client.overagePackPurchase.findUnique({
        where: { id: purchaseId },
    });
    if (!purchase) {
        throw new Error(`[overage-pack] 购买记录不存在: ${purchaseId}`);
    }
    // ---- 2. 幂等检查 ----
    if (purchase.status === 'PURCHASED') {
        log.info({ purchaseId }, '超额包已发放，跳过（幂等）');
        return { fulfilled: false, purchaseId: purchase.id };
    }
    if (purchase.status !== 'PENDING') {
        throw new Error(`[overage-pack] 购买状态异常，期望 PENDING，实际: ${purchase.status}`);
    }
    // ---- 3. 更新状态为 PURCHASED ----
    const now = new Date();
    await client.overagePackPurchase.update({
        where: { id: purchaseId },
        data: {
            status: 'PURCHASED',
            fulfilledAt: now,
        },
    });
    log.info({ purchaseId }, '超额包购买状态更新为 PURCHASED');
    // ---- 4. 创建 OVERAGE_PACK bucket + GRANT ledger ----
    const externalId = purchase.externalPurchaseId ?? purchase.id;
    const cycleKey = `OVERAGE:${externalId}`;
    const grantResult = await grantCreditBucket({
        shopId: purchase.shopId,
        bucketType: 'OVERAGE_PACK',
        amount: purchase.grantedAmount,
        cycleKey,
        overagePackPurchaseId: purchase.id,
        source: 'overage-pack',
        sourceRef: externalId,
        reason: `超额包 ${purchase.packCode} 额度发放（${purchase.grantedAmount} 次）`,
    }, client);
    log.info({
        purchaseId,
        shopId: purchase.shopId,
        packCode: purchase.packCode,
        cycleKey,
        bucketId: grantResult.bucket.id,
        created: grantResult.created,
    }, '超额包额度发放完成');
    return {
        fulfilled: grantResult.created,
        purchaseId: purchase.id,
        bucketId: grantResult.bucket.id,
    };
}
