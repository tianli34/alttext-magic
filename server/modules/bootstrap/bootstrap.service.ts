/**
 * File: server/modules/bootstrap/bootstrap.service.ts
 * Purpose: Bootstrap 聚合服务 —— 为 GET /api/bootstrap 提供一次性聚合数据，
 *          包括计划/额度占位、notice 状态、scope 状态和最近扫描状态。
 *
 * 设计要点：
 *   - 对 fresh shop（无任何扫描记录、未确认 notice）返回正确默认态
 *   - effective_read_scope_flags 为计算值，不入库
 *   - 不依赖 Phase 3 计费数据也能正常返回（计划/额度为占位）
 */
import { ScanJobStatus } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { SCAN_NOTICE_VERSION } from "../../config/constants";
import { createLogger } from "../../utils/logger";
import { getNoticeStatus } from "../notice/scan-notice-ack.service";
import {
  computeEffectiveReadScopeFlags,
  DEFAULT_SCAN_SCOPE_FLAGS,
} from "../shop/scope.service";
import { normalizeScopeFlagState } from "../../../app/lib/scope-utils";
import type { ScanScopeFlags } from "../shop/shop.types";
import type {
  BootstrapData,
  LatestScanStatus,
  PlanSummary,
  QuotaSummary,
} from "./bootstrap.types";

const logger = createLogger({ module: "bootstrap-service" });

/* ------------------------------------------------------------------ */
/*  辅助：fresh shop 的默认返回                                        */
/* ------------------------------------------------------------------ */

function buildFreshShopDefault(): BootstrapData {
  return {
    plan: { planCode: "FREE" },
    quota: { includedRemaining: 0, includedPeriodType: "NONE" },
    needsNoticeAck: true,
    noticeVersion: SCAN_NOTICE_VERSION,
    scanScopeFlags: { ...DEFAULT_SCAN_SCOPE_FLAGS },
    lastPublishedScopeFlags: null,
    effectiveReadScopeFlags: computeEffectiveReadScopeFlags(
      DEFAULT_SCAN_SCOPE_FLAGS,
      null,
    ),
    latestScan: null,
  };
}

/* ------------------------------------------------------------------ */
/*  辅助：从 ScanJob 记录构建 LatestScanStatus                         */
/* ------------------------------------------------------------------ */

function buildLatestScanStatus(job: {
  id: string;
  status: ScanJobStatus;
  publishStatus: string;
  publishedAt: Date | null;
}): LatestScanStatus {
  const isRunning =
    job.status === ScanJobStatus.RUNNING;

  return {
    scanJobId: job.id,
    status: job.status,
    publishStatus: job.publishStatus,
    isRunning,
    lastPublishedAt: job.publishedAt ? job.publishedAt.toISOString() : null,
  };
}

/* ------------------------------------------------------------------ */
/*  主函数                                                             */
/* ------------------------------------------------------------------ */

/**
 * 获取 Bootstrap 聚合数据。
 *
 * @param shopId - 店铺内部 ID（Prisma shops.id）
 * @returns BootstrapData 聚合结果
 *
 * 聚合内容：
 *   1. 计划信息占位（planCode 直接从 shops.currentPlan 读取）
 *   2. 额度信息占位（Phase 3 前返回默认值）
 *   3. notice 状态（调用 getNoticeStatus）
 *   4. scope 状态（scan / lastPublished / effectiveRead）
 *   5. 最近扫描状态（无则 null）
 */
export async function getBootstrapData(shopId: string): Promise<BootstrapData> {
  // 1. 并行获取 shop 基础数据 + notice 状态 + 最近扫描
  const [shop, noticeStatus, latestJob] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: {
        currentPlan: true,
        scanScopeFlags: true,
        lastPublishedScopeFlags: true,
      },
    }),
    getNoticeStatus(shopId, SCAN_NOTICE_VERSION),
    prisma.scanJob.findFirst({
      where: { shopId },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        status: true,
        publishStatus: true,
        publishedAt: true,
      },
    }),
  ]);

  // 2. shop 不存在时返回默认态（理论上不应发生，但做防御性处理）
  if (!shop) {
    logger.warn({ shopId }, "Shop not found, returning fresh default");
    return buildFreshShopDefault();
  }

  // 3. 构建 scope 三件套
  const scanScopeFlags: ScanScopeFlags = normalizeScopeFlagState(
    shop.scanScopeFlags,
  );
  const lastPublishedScopeFlags: ScanScopeFlags | null =
    shop.lastPublishedScopeFlags
      ? normalizeScopeFlagState(shop.lastPublishedScopeFlags)
      : null;
  const effectiveReadScopeFlags = computeEffectiveReadScopeFlags(
    scanScopeFlags,
    lastPublishedScopeFlags,
  );

  // 4. 计划占位
  const plan: PlanSummary = {
    planCode: shop.currentPlan,
  };

  // 5. 额度占位（Phase 3 前返回默认值）
  const quota: QuotaSummary = {
    includedRemaining: 0,
    includedPeriodType: "NONE",
  };

  // 6. 最近扫描状态
  const latestScan: LatestScanStatus | null = latestJob
    ? buildLatestScanStatus(latestJob)
    : null;

  return {
    plan,
    quota,
    needsNoticeAck: noticeStatus.needsNoticeAck,
    noticeVersion: noticeStatus.currentVersion,
    scanScopeFlags,
    lastPublishedScopeFlags,
    effectiveReadScopeFlags,
    latestScan,
  };
}
