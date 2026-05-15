/**
 * File: server/modules/billing/credit/free-monthly-grant.service.ts
 * Purpose: Free 月配额自动发放服务。
 *          查询所有 currentPlan = FREE 且缺少当月 FREE_MONTHLY_INCLUDED bucket 的店铺，
 *          调用 grantCreditBucket 逐一发放。
 *
 * 设计要点：
 *   - 幂等：grantCreditBucket 内部通过唯一约束保证同月不重复创建。
 *   - 单一职责：本服务仅负责"查找缺失 + 发放"逻辑，不含调度逻辑。
 *   - 可测试：PrismaClient 通过参数注入，方便 mock。
 */
import { createLogger } from '../../../utils/logger.js';
import { grantCreditBucket } from './grant-credit.server.js';
import { getFreeCycleKey } from '../plan-config.js';
// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------
const log = createLogger({ module: 'free-monthly-grant' });
// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------
/** Free 计划月配额 */
const FREE_MONTHLY_CREDITS = 25;
/** 额度桶类型 */
const FREE_BUCKET_TYPE = 'FREE_MONTHLY_INCLUDED';
// ----------------------------------------------------------------------------
// 辅助函数
// ----------------------------------------------------------------------------
/**
 * 计算指定日期所在 UTC 自然月的 cycleKey。
 * @param date 锚点日期（默认 new Date()，即当前时间）
 * @returns cycleKey 字符串，如 "FREE:2026-05"
 */
export function computeCycleKey(date) {
    return getFreeCycleKey(date ?? new Date());
}
// ----------------------------------------------------------------------------
// 核心实现
// ----------------------------------------------------------------------------
/**
 * 执行一次 Free 月配额批量发放。
 *
 * ### 流程
 * 1. 计算当前 UTC 自然月的 cycleKey（`FREE:YYYY-MM`）
 * 2. 查询所有 `currentPlan = FREE` 且当月没有 `FREE_MONTHLY_INCLUDED` bucket 的店铺
 * 3. 逐一调用 `grantCreditBucket` 发放 25 额度
 * 4. 返回发放结果统计
 *
 * ### 幂等保证
 * - `grantCreditBucket` 通过 `@@unique([shopId, bucketType, cycleKey])` 保证幂等。
 * - 同月重复执行只会返回 skippedCount 增加，不会重复发放。
 *
 * @param targetMonth 可选目标月份（YYYY-MM），为空则使用当前 UTC 月份
 * @param client 可选 PrismaClient 实例（默认使用全局单例，方便测试注入）
 */
export async function grantFreeMonthlyToAllShops(targetMonth, client) {
    // ---- 懒加载全局 Prisma 单例 ----
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
    const db = client ?? (await import('../../../db/prisma.server.js')).default;
    const now = new Date();
    const cycleKey = targetMonth
        ? `FREE:${targetMonth}`
        : computeCycleKey(now);
    // 验证 targetMonth 格式
    if (targetMonth && !/^\d{4}-\d{2}$/.test(targetMonth)) {
        throw new Error(`[free-monthly-grant] targetMonth 格式无效: ${targetMonth}，期望 YYYY-MM`);
    }
    log.info({ cycleKey, targetMonth }, '开始 Free 月配额批量发放');
    // ---- 查询所有 Free 店铺且没有当月 bucket 的 ----
    // 策略：先查所有 Free 店铺，再 LEFT JOIN 排除已有 bucket 的
    const freeShops = await db.shop.findMany({
        where: {
            currentPlan: 'FREE',
            // 排除已卸载的店铺
            uninstalledAt: null,
        },
        select: {
            id: true,
            shopDomain: true,
        },
    });
    log.info({ freeShopCount: freeShops.length }, '扫描到 Free 店铺');
    if (freeShops.length === 0) {
        return {
            totalFreeShops: 0,
            grantedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            failures: [],
        };
    }
    // ---- 查询已有当月 bucket 的 shopId 集合 ----
    const existingBuckets = await db.creditBucket.findMany({
        where: {
            bucketType: FREE_BUCKET_TYPE,
            cycleKey,
            shopId: { in: freeShops.map((s) => s.id) },
        },
        select: { shopId: true },
    });
    const existingShopIds = new Set(existingBuckets.map((b) => b.shopId));
    // ---- 筛选需要发放的店铺 ----
    const shopsToGrant = freeShops.filter((s) => !existingShopIds.has(s.id));
    log.info({
        totalFreeShops: freeShops.length,
        existingBucketCount: existingShopIds.size,
        toGrantCount: shopsToGrant.length,
    }, '筛选完成，开始逐店发放');
    // ---- 计算当月生效时间和过期时间 ----
    // cycleKey 格式为 "FREE:YYYY-MM"，提取 YYYY-MM 部分
    const cycleMonth = cycleKey.slice(5); // "YYYY-MM"
    const [year, month] = cycleMonth.split('-').map(Number);
    const effectiveAt = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
    // 过期时间：下月1日 00:00:00 UTC
    const expiresAt = new Date(Date.UTC(year, month, 1, 0, 0, 0));
    // ---- 逐店发放 ----
    let grantedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const failures = [];
    for (const shop of shopsToGrant) {
        try {
            const result = await grantCreditBucket({
                shopId: shop.id,
                bucketType: FREE_BUCKET_TYPE,
                amount: FREE_MONTHLY_CREDITS,
                cycleKey,
                effectiveAt,
                expiresAt,
                source: 'free-monthly-grant',
                reason: `Free 月配额自动发放 (${cycleMonth})`,
            }, db);
            if (result.created) {
                grantedCount++;
                log.info({ shopId: shop.id, shopDomain: shop.shopDomain, cycleKey }, 'Free 月配额发放成功');
            }
            else {
                skippedCount++;
                log.info({ shopId: shop.id, shopDomain: shop.shopDomain, cycleKey }, 'Free 月配额已存在（幂等跳过）');
            }
        }
        catch (error) {
            failedCount++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            failures.push({ shopId: shop.id, error: errorMessage });
            log.error({ shopId: shop.id, shopDomain: shop.shopDomain, cycleKey, err: error }, 'Free 月配额发放失败');
            // 不中断循环，继续处理其他店铺
        }
    }
    const result = {
        totalFreeShops: freeShops.length,
        grantedCount,
        skippedCount: skippedCount + existingShopIds.size,
        failedCount,
        failures,
    };
    log.info(result, 'Free 月配额批量发放完成');
    return result;
}
