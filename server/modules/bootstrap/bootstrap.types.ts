/**
 * File: server/modules/bootstrap/bootstrap.types.ts
 * Purpose: Bootstrap 聚合接口的类型定义。
 *          GET /api/bootstrap 返回的所有字段类型集中在此声明。
 */
import type { ScanScopeFlags } from "../shop/shop.types";

/* ------------------------------------------------------------------ */
/*  计划与额度摘要（Phase 3 占位，当前仅返回默认值）                    */
/* ------------------------------------------------------------------ */

/** 计划信息占位 */
export interface PlanSummary {
  /** 当前计划代码，如 FREE / PRO */
  planCode: string;
}

/** 额度信息占位 */
export interface QuotaSummary {
  /** 剩余可用额度 */
  includedRemaining: number;
  /** 额度周期类型 */
  includedPeriodType: string;
}

/* ------------------------------------------------------------------ */
/*  最近扫描状态                                                       */
/* ------------------------------------------------------------------ */

/** 最近一次扫描的精简状态，无扫描记录时为 null */
export interface LatestScanStatus {
  /** 扫描任务 ID */
  scanJobId: string;
  /** 扫描任务状态 */
  status: string;
  /** 发布状态 */
  publishStatus: string;
  /** 是否有正在运行的扫描 */
  isRunning: boolean;
  /** 最近发布时间 */
  lastPublishedAt: string | null;
}

/* ------------------------------------------------------------------ */
/*  Bootstrap 聚合返回                                                 */
/* ------------------------------------------------------------------ */

/** GET /api/bootstrap 完整返回体 */
export interface BootstrapData {
  /** 计划信息（占位） */
  plan: PlanSummary;
  /** 额度摘要（占位） */
  quota: QuotaSummary;

  /** 是否需要确认扫描说明 */
  needsNoticeAck: boolean;
  /** 当前 notice 版本 */
  noticeVersion: string;

  /** 当前配置的扫描 scope */
  scanScopeFlags: ScanScopeFlags;
  /** 最近一次已发布结果覆盖的 scope */
  lastPublishedScopeFlags: ScanScopeFlags | null;
  /** 前台有效读取 scope（计算值，不入库） */
  effectiveReadScopeFlags: ScanScopeFlags;

  /** 最近扫描状态，无扫描记录时为 null */
  latestScan: LatestScanStatus | null;
}
