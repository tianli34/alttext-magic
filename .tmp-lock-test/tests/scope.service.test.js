/**
 * File: tests/scope.service.test.ts
 * Purpose: 单测 scope.service 的纯函数逻辑。
 *
 * 验收：
 * - 输入非法 flag 会报错
 * - fresh shop 默认四类全开
 * - computeEffectiveReadScopeFlags 正确计算交集
 * - grantedReadScopes 为 null 时 effective 全 false
 *
 * 注：getScopeSettings / updateScanScopeFlags 依赖 Prisma DB，
 *     需要集成测试环境，此处仅测纯函数。
 */
import assert from "node:assert/strict";
import { computeEffectiveReadScopeFlags, DEFAULT_SCAN_SCOPE_FLAGS, normalizeScanScopeFlags, } from "../server/modules/shop/scope.service";
function run() {
    /* ================================================================ */
    /*  1. 默认值：四类全开                                              */
    /* ================================================================ */
    assert.deepEqual(DEFAULT_SCAN_SCOPE_FLAGS, {
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
    }, "默认 scan scope flags 应为四类全开");
    /* ================================================================ */
    /*  2. normalizeScanScopeFlags —— 合法输入                          */
    /* ================================================================ */
    const partial = {
        PRODUCT_MEDIA: true,
        FILES: false,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: false,
    };
    assert.deepEqual(normalizeScanScopeFlags(partial), partial, "合法 ScopeFlagState 应原样归一化返回");
    // 全 false 也合法
    const allOff = {
        PRODUCT_MEDIA: false,
        FILES: false,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
    };
    assert.deepEqual(normalizeScanScopeFlags(allOff), allOff, "全 false 输入应合法");
    /* ================================================================ */
    /*  3. normalizeScanScopeFlags —— 非法输入报错                      */
    /* ================================================================ */
    // 3a. 缺少字段
    assert.throws(() => normalizeScanScopeFlags({ PRODUCT_MEDIA: true, FILES: true }), "缺少必需字段应抛错");
    // 3b. 额外字段
    assert.throws(() => normalizeScanScopeFlags({
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
        INVALID_FLAG: true,
    }), "多余字段应抛错");
    // 3c. 值类型错误
    assert.throws(() => normalizeScanScopeFlags({
        PRODUCT_MEDIA: "yes",
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
    }), "布尔值类型错误应抛错");
    // 3d. 完全非法类型
    assert.throws(() => normalizeScanScopeFlags("not-an-object"), "字符串输入应抛错");
    assert.throws(() => normalizeScanScopeFlags(null), "null 输入应抛错");
    assert.throws(() => normalizeScanScopeFlags(123), "数字输入应抛错");
    /* ================================================================ */
    /*  4. computeEffectiveReadScopeFlags —— grantedReadScopes 为 null  */
    /* ================================================================ */
    const allOn = { ...DEFAULT_SCAN_SCOPE_FLAGS };
    const effectiveWhenNull = computeEffectiveReadScopeFlags(allOn, null);
    assert.deepEqual(effectiveWhenNull, {
        PRODUCT_MEDIA: false,
        FILES: false,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
    }, "grantedReadScopes 为 null 时，effective 应全部为 false");
    /* ================================================================ */
    /*  5. computeEffectiveReadScopeFlags —— 交集计算                    */
    /* ================================================================ */
    // 5a. 两者完全相同且全开
    const effectiveAllOn = computeEffectiveReadScopeFlags(allOn, allOn);
    assert.deepEqual(effectiveAllOn, allOn, "两者全开时 effective 应全开");
    // 5b. scanScopeFlags 部分开，grantedReadScopes 全开
    const scanPartial = {
        PRODUCT_MEDIA: true,
        FILES: false,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: false,
    };
    const effectivePartialScan = computeEffectiveReadScopeFlags(scanPartial, allOn);
    assert.deepEqual(effectivePartialScan, scanPartial, "granted 全开、scan 部分开时，effective = scan");
    // 5c. scanScopeFlags 全开，grantedReadScopes 部分开
    const grantedPartial = {
        PRODUCT_MEDIA: true,
        FILES: false,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: false,
    };
    const effectivePartialGranted = computeEffectiveReadScopeFlags(allOn, grantedPartial);
    assert.deepEqual(effectivePartialGranted, grantedPartial, "scan 全开、granted 部分开时，effective = granted");
    // 5d. 两者各自开了不同的类型 —— 交集为空
    const scanAB = {
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
    };
    const grantedCD = {
        PRODUCT_MEDIA: false,
        FILES: false,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
    };
    const effectiveDisjoint = computeEffectiveReadScopeFlags(scanAB, grantedCD);
    assert.deepEqual(effectiveDisjoint, {
        PRODUCT_MEDIA: false,
        FILES: false,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: false,
    }, "两者各自开不同类型时，交集应为全 false");
    // 5e. 两者部分重叠
    const scanOverlap = {
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: true,
    };
    const grantedOverlap = {
        PRODUCT_MEDIA: true,
        FILES: false,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
    };
    const effectiveOverlap = computeEffectiveReadScopeFlags(scanOverlap, grantedOverlap);
    assert.deepEqual(effectiveOverlap, {
        PRODUCT_MEDIA: true,
        FILES: false,
        COLLECTION_IMAGE: false,
        ARTICLE_IMAGE: true,
    }, "部分重叠时 effective 应只保留两者都为 true 的项");
    console.log("✅ scope.service 纯函数单测全部通过");
}
run();
