/**
 * File: server/modules/billing/credit/consumption-order.ts
 * Purpose: 额度消费顺序定义与排序工具。
 *
 * ### 消费顺序（规格文档 §4.9.4）
 * 1. Included family（按最早到期优先）：
 *    - FREE_MONTHLY_INCLUDED
 *    - MONTHLY_INCLUDED
 *    - ANNUAL_INCLUDED
 * 2. WELCOME
 * 3. OVERAGE_PACK
 *
 * Included family 内部排序：
 * - expires_at ASC（null 视为无穷大排最后）
 * - effective_at ASC
 * - created_at ASC
 */
// ---------------------------------------------------------------------------
// 消费优先级权重（值越小越优先）
// ---------------------------------------------------------------------------
/** 各桶类型的消费优先级权重 */
const CONSUMPTION_PRIORITY = {
    FREE_MONTHLY_INCLUDED: 10,
    MONTHLY_INCLUDED: 10,
    ANNUAL_INCLUDED: 10,
    WELCOME: 20,
    OVERAGE_PACK: 30,
};
// ---------------------------------------------------------------------------
// included family 集合
// ---------------------------------------------------------------------------
/** included family 类型集合 */
const INCLUDED_FAMILY_TYPES = new Set([
    'FREE_MONTHLY_INCLUDED',
    'MONTHLY_INCLUDED',
    'ANNUAL_INCLUDED',
]);
/**
 * 判断桶类型是否属于 included family。
 */
export function isIncludedFamily(bucketType) {
    return INCLUDED_FAMILY_TYPES.has(bucketType);
}
/**
 * 获取桶的消费优先级权重。
 * included family 共享同一权重（10），内部再按到期时间排序。
 */
export function getConsumptionPriority(bucketType) {
    return CONSUMPTION_PRIORITY[bucketType];
}
/**
 * 按 §4.9.4 消费顺序对可消费桶进行排序。
 *
 * 排序规则：
 * 1. 按消费优先级权重 ASC（included 10 → welcome 20 → overage 30）
 * 2. included family 内部：
 *    - expires_at ASC（null 排最后）
 *    - effective_at ASC
 *    - created_at ASC
 *
 * @param items  待排序的元素数组
 * @param keyExtractor 可选，从元素中提取 SpendableBucket 的函数。
 *                     不传时 items 须直接实现 SpendableBucket 接口。
 */
export function sortBucketsByConsumptionOrder(items, keyExtractor) {
    const getKey = keyExtractor ?? ((item) => item);
    return [...items].sort((a, b) => {
        const ka = getKey(a);
        const kb = getKey(b);
        // 1. 按消费优先级分组
        const priorityDiff = getConsumptionPriority(ka.bucketType) - getConsumptionPriority(kb.bucketType);
        if (priorityDiff !== 0)
            return priorityDiff;
        // 2. included family 内部按到期时间排序
        if (isIncludedFamily(ka.bucketType) && isIncludedFamily(kb.bucketType)) {
            // expiresAt ASC — null 视为无穷大（排最后）
            const aExpires = ka.expiresAt?.getTime() ?? Infinity;
            const bExpires = kb.expiresAt?.getTime() ?? Infinity;
            if (aExpires !== bExpires)
                return aExpires - bExpires;
            // effectiveAt ASC
            const effectiveDiff = ka.effectiveAt.getTime() - kb.effectiveAt.getTime();
            if (effectiveDiff !== 0)
                return effectiveDiff;
            // createdAt ASC
            return ka.createdAt.getTime() - kb.createdAt.getTime();
        }
        return 0;
    });
}
