/**
 * File: server/services/gates/planGate.ts
 * Purpose: Gate 2 — 计划权限门控。
 *          检查店铺的 incrementalScanEnabled 状态（读取 shops 表冗余字段），
 *          付费计划返回 true，Free 计划返回 false。
 *
 * 使用方式（在 worker processor 中）：
 * ```ts
 * const enabled = await checkIncrementalEnabled(shopId);
 * if (!enabled) {
 *   // 标记 webhook_event SKIPPED_PLAN
 *   return;
 * }
 * // 正常业务处理 ...
 * ```
 */

import prisma from "../../db/prisma.server";

/* ------------------------------------------------------------------ */
/*  可注入依赖（方便测试）                                              */
/* ------------------------------------------------------------------ */

/** 查询 incrementalScanEnabled 的函数签名 */
export type CheckIncrementalEnabledFn = (shopId: string) => Promise<boolean>;

/** 当前注入的 checkIncrementalEnabled 实现 */
let _checkIncrementalEnabled: CheckIncrementalEnabledFn = async (shopId) => {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { incrementalScanEnabled: true },
  });

  return shop?.incrementalScanEnabled ?? false;
};

/**
 * 注入自定义 checkIncrementalEnabled 实现（测试用）。
 */
export function setCheckIncrementalEnabledFn(fn: CheckIncrementalEnabledFn): void {
  _checkIncrementalEnabled = fn;
}

/**
 * 重置为默认实现。
 */
export function resetPlanGateDeps(): void {
  _checkIncrementalEnabled = async (shopId) => {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { incrementalScanEnabled: true },
    });

    return shop?.incrementalScanEnabled ?? false;
  };
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 检查指定店铺是否启用了增量扫描（incremental scan）。
 *
 * 直接读取 shops 表的 incrementalScanEnabled 冗余字段，
 * 避免联表查询 billing_subscription，性能更优：
 * - 付费计划（incrementalScanEnabled=true）→ true
 * - Free 计划（incrementalScanEnabled=false）→ false
 *
 * @param shopId 店铺 ID
 * @returns true=增量扫描已启用，false=未启用
 */
export async function checkIncrementalEnabled(shopId: string): Promise<boolean> {
  return _checkIncrementalEnabled(shopId);
}
