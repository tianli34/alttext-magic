/**
 * File: server/modules/shop/scope.service.ts
 * Purpose: Scope 服务 —— 负责 shops.scan_scope_flags 的读取、更新，
 *          以及 effective read scope 的计算。
 *
 * 三类 scope（见规格 4.2.2）：
 *   A. scan_scope_flags          —— 用户当前希望处理的资源类型
 *   B. last_published_scope_flags —— 最近一次已发布结果实际覆盖的资源类型
 *   C. effective_read_scope_flags —— A ∩ B，前台实际可见的分组
 */
import {
  DEFAULT_SCOPE_FLAG_STATE,
  EMPTY_SCOPE_FLAG_STATE,
  normalizeScopeFlagState,
  SCOPE_FLAG_ORDER,
  scopeFlagStateSchema,
} from "../../../app/lib/scope-utils";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";
import type { ScanScopeFlags } from "./shop.types";

const logger = createLogger({ module: "scope-service" });

/* ------------------------------------------------------------------ */
/*  常量                                                               */
/* ------------------------------------------------------------------ */

/** 默认四类全开 */
export const DEFAULT_SCAN_SCOPE_FLAGS: ScanScopeFlags = {
  ...DEFAULT_SCOPE_FLAG_STATE,
};

/* ------------------------------------------------------------------ */
/*  返回类型                                                           */
/* ------------------------------------------------------------------ */

export interface ScopeSettings {
  /** 用户当前配置的扫描 scope */
  scanScopeFlags: ScanScopeFlags;
  /** 最近一次已发布结果覆盖的 scope（可能为 null = 尚未发布过） */
  lastPublishedScopeFlags: ScanScopeFlags | null;
  /** 前台有效读取 scope = scanScopeFlags ∩ lastPublishedScopeFlags */
  effectiveReadScopeFlags: ScanScopeFlags;
}

/* ------------------------------------------------------------------ */
/*  纯函数                                                             */
/* ------------------------------------------------------------------ */

/**
 * 计算前台有效读取 scope。
 * 规则：scanScopeFlags ∩ grantedReadScopes（即 lastPublishedScopeFlags）。
 * 若 grantedReadScopes 为 null（尚未发布过），则返回全 false。
 */
export function computeEffectiveReadScopeFlags(
  scanScopeFlags: ScanScopeFlags,
  grantedReadScopes: ScanScopeFlags | null,
): ScanScopeFlags {
  if (grantedReadScopes === null) {
    return { ...EMPTY_SCOPE_FLAG_STATE };
  }

  return SCOPE_FLAG_ORDER.reduce(
    (acc, flag) => {
      acc[flag] = scanScopeFlags[flag] && grantedReadScopes[flag];
      return acc;
    },
    { ...EMPTY_SCOPE_FLAG_STATE },
  );
}

/**
 * 归一化并校验 scan scope flags 输入。
 * 非法 flag 会导致 ZodError 抛出。
 */
export function normalizeScanScopeFlags(input: unknown): ScanScopeFlags {
  return normalizeScopeFlagState(input);
}

/* ------------------------------------------------------------------ */
/*  异步服务函数                                                       */
/* ------------------------------------------------------------------ */

/**
 * 读取 shop 的 scope 设置。
 * - scanScopeFlags: 若 DB 中为 null（不应发生），回退到默认四类全开
 * - lastPublishedScopeFlags: 若为 null 表示尚未发布过
 * - effectiveReadScopeFlags: 由上面两个值计算得出
 */
export async function getScopeSettings(shopId: string): Promise<ScopeSettings> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      scanScopeFlags: true,
      lastPublishedScopeFlags: true,
    },
  });

  if (!shop) {
    logger.warn({ shopId }, "Shop not found, returning default scope settings");
    return {
      scanScopeFlags: { ...DEFAULT_SCAN_SCOPE_FLAGS },
      lastPublishedScopeFlags: null,
      effectiveReadScopeFlags: computeEffectiveReadScopeFlags(
        DEFAULT_SCAN_SCOPE_FLAGS,
        null,
      ),
    };
  }

  const scanScopeFlags = normalizeScopeFlagState(shop.scanScopeFlags);
  const lastPublishedScopeFlags = shop.lastPublishedScopeFlags
    ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
    : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    scanScopeFlags,
    lastPublishedScopeFlags,
  );

  return {
    scanScopeFlags,
    lastPublishedScopeFlags,
    effectiveReadScopeFlags,
  };
}

/**
 * 更新 shop 的 scan_scope_flags。
 * - 仅修改 scan_scope_flags 和 scan_scope_updated_at
 * - 绝不修改 last_published_scope_flags
 * - 输入非法 flag 会抛出 ZodError
 *
 * 返回更新后的完整 ScopeSettings。
 */
export async function updateScanScopeFlags(
  shopId: string,
  flags: unknown,
): Promise<ScopeSettings> {
  // 1. 校验 & 归一化 —— 非法 flag 在此处抛出
  const validated = scopeFlagStateSchema.parse(flags);
  const normalized = normalizeScopeFlagState(validated);

  // 2. 只更新 scan_scope_flags 和 scan_scope_updated_at
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      scanScopeFlags: normalized as Record<string, boolean>,
      scanScopeUpdatedAt: new Date(),
    },
    select: { id: true }, // 最小 select，不需要返回数据
  });

  logger.info(
    { shopId, scanScopeFlags: normalized },
    "Updated scan_scope_flags",
  );

  // 3. 读取 lastPublishedScopeFlags 以计算 effective
  const shop = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { lastPublishedScopeFlags: true },
  });

  const lastPublishedScopeFlags = shop.lastPublishedScopeFlags
    ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
    : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    normalized,
    lastPublishedScopeFlags,
  );

  return {
    scanScopeFlags: normalized,
    lastPublishedScopeFlags,
    effectiveReadScopeFlags,
  };
}
