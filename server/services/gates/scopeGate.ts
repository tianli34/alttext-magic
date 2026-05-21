/**
 * File: server/services/gates/scopeGate.ts
 * Purpose: Gate 3 — Scope 门控。
 *          检查店铺的 scan_scope_flags 是否包含指定 topic 对应的资源类型，
 *          scope 关闭时返回 false → 调用方标记 webhook_event SKIPPED_SCOPE。
 *
 * Topic → ResourceType 映射：
 *   products/update    → PRODUCT_MEDIA
 *   collections/update → COLLECTION_IMAGE
 *
 * 使用方式（在 worker processor 中）：
 * ```ts
 * const ok = await checkScopeForTopic(shopId, topic);
 * if (!ok) {
 *   // 标记 webhook_event SKIPPED_SCOPE
 *   return;
 * }
 * // 正常业务处理 ...
 * ```
 */

import prisma from "../../db/prisma.server";

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

/**
 * Topic → ResourceType 映射。
 * 每个 topic 对应 scan_scope_flags 中的一个 key。
 */
const TOPIC_TO_RESOURCE_TYPE: Record<string, string> = {
  "products/update": "PRODUCT_MEDIA",
  "collections/update": "COLLECTION_IMAGE",
} as const;

/* ------------------------------------------------------------------ */
/*  可注入依赖（方便测试）                                              */
/* ------------------------------------------------------------------ */

/** 查询 scan_scope_flags 的函数签名 */
export type CheckScopeForTopicFn = (
  shopId: string,
  topic: string,
) => Promise<boolean>;

/** 当前注入的 checkScopeForTopic 实现 */
let _checkScopeForTopic: CheckScopeForTopicFn = async (shopId, topic) => {
  const resourceType = TOPIC_TO_RESOURCE_TYPE[topic];
  if (!resourceType) {
    return true;
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { scanScopeFlags: true },
  });

  if (!shop?.scanScopeFlags) {
    return false;
  }

  const flags = shop.scanScopeFlags as Record<string, boolean>;
  return flags[resourceType] === true;
};

/**
 * 注入自定义 checkScopeForTopic 实现（测试用）。
 */
export function setCheckScopeForTopicFn(fn: CheckScopeForTopicFn): void {
  _checkScopeForTopic = fn;
}

/**
 * 重置为默认实现。
 */
export function resetScopeGateDeps(): void {
  _checkScopeForTopic = async (shopId, topic) => {
    const resourceType = TOPIC_TO_RESOURCE_TYPE[topic];
    if (!resourceType) {
      return true;
    }

    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { scanScopeFlags: true },
    });

    if (!shop?.scanScopeFlags) {
      return false;
    }

    const flags = shop.scanScopeFlags as Record<string, boolean>;
    return flags[resourceType] === true;
  };
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 检查指定店铺是否启用了指定 topic 对应的资源类型扫描。
 *
 * 根据 topic 映射到 resourceType，然后查询 shops.scan_scope_flags：
 * - flags[resourceType] === true → 返回 true（放行）
 * - 其他情况 → 返回 false（scope 关闭）
 * - 未知 topic → 返回 true（放行，避免阻塞未识别的 topic）
 *
 * @param shopId 店铺 ID
 * @param topic  Shopify webhook topic（如 "products/update"）
 * @returns true=scope 已开启可处理，false=scope 关闭
 */
export async function checkScopeForTopic(
  shopId: string,
  topic: string,
): Promise<boolean> {
  return _checkScopeForTopic(shopId, topic);
}
