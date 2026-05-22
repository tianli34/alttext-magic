/**
 * File: server/services/gates/fingerprintGate.ts
 * Purpose: Gate 4 — 图片指纹门控。
 *          将最新计算的图片指纹与数据库中存储的历史指纹比对，
 *          相同则返回 UNCHANGED → 调用方标记 webhook_event SKIPPED_NO_IMAGE_CHANGE。
 *
 * 使用方式（在 worker processor 中）：
 * ```ts
 * const fp = computeProductFingerprint(mediaImages);
 * const result = await checkFingerprintChange(shopId, "PRODUCT", resourceId, fp);
 * if (result === "UNCHANGED") {
 *   // 标记 webhook_event SKIPPED_NO_IMAGE_CHANGE
 *   return;
 * }
 * // 正常业务处理 ...
 * ```
 */

import type { ResourceImageFingerprintResourceType } from "@prisma/client";
import { compareAndDecide } from "../../modules/fingerprint/fingerprintRepo";

/* ------------------------------------------------------------------ */
/*  可注入依赖（方便测试）                                              */
/* ------------------------------------------------------------------ */

/** 检查图片指纹是否变更的函数签名 */
export type CheckFingerprintChangeFn = (
  shopId: string,
  resourceType: ResourceImageFingerprintResourceType,
  resourceId: string,
  currentFingerprint: string,
) => Promise<"CHANGED" | "UNCHANGED">;

/** 当前注入的 checkFingerprintChange 实现 */
let _checkFingerprintChange: CheckFingerprintChangeFn = async (
  shopId,
  resourceType,
  resourceId,
  currentFingerprint,
) => {
  return compareAndDecide(shopId, resourceType, resourceId, currentFingerprint);
};

/**
 * 注入自定义 checkFingerprintChange 实现（测试用）。
 */
export function setCheckFingerprintChangeFn(
  fn: CheckFingerprintChangeFn,
): void {
  _checkFingerprintChange = fn;
}

/**
 * 重置为默认实现。
 */
export function resetFingerprintGateDeps(): void {
  _checkFingerprintChange = async (
    shopId,
    resourceType,
    resourceId,
    currentFingerprint,
  ) => {
    return compareAndDecide(shopId, resourceType, resourceId, currentFingerprint);
  };
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 检查指定资源的图片指纹是否已发生变化。
 *
 * 将本次计算的指纹与数据库中存储的历史指纹比对：
 * - 无历史记录（首次处理）→ 返回 CHANGED（需要继续处理）
 * - 相同 → 返回 UNCHANGED（图片未变，调用方应标记 SKIPPED_NO_IMAGE_CHANGE）
 * - 不同 → 返回 CHANGED（图片已变，需要继续处理并更新指纹）
 *
 * @param shopId            店铺 ID
 * @param resourceType      资源类型（PRODUCT | COLLECTION）
 * @param resourceId        资源 ID
 * @param currentFingerprint  本次计算的新指纹
 * @returns "CHANGED" | "UNCHANGED"
 */
export async function checkFingerprintChange(
  shopId: string,
  resourceType: ResourceImageFingerprintResourceType,
  resourceId: string,
  currentFingerprint: string,
): Promise<"CHANGED" | "UNCHANGED"> {
  return _checkFingerprintChange(shopId, resourceType, resourceId, currentFingerprint);
}
