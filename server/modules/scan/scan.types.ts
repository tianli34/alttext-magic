/**
 * File: server/modules/scan/scan.types.ts
 * Purpose: 扫描模块的共享类型定义。
 */
import type { ScanResourceType, ScanJobStatus, ScanTaskStatus, ScanTaskAttemptStatus, ScanJobPublishStatus } from "@prisma/client";
import type { ScopeFlag } from "../../../app/lib/scope-utils";

/** 扫描任务创建结果 */
export interface ScanTaskCreateInfo {
  id: string;
  resourceType: ScanResourceType;
}

/** 创建 scan_job + scan_task 事务的输入参数 */
export interface CreateScanJobParams {
  shopId: string;
  scopeFlags: Record<string, boolean>;
  noticeVersion: string;
  /** 已启用的资源类型列表，用于决定创建哪些 scan_task */
  enabledResourceTypes: ScanResourceType[];
}

/** 创建 scan_job + scan_task 事务的输出结果 */
export interface CreateScanJobResult {
  scanJobId: string;
  scanJobStatus: ScanJobStatus;
  tasks: ScanTaskCreateInfo[];
}

/** Redis 扫描进度键的值结构 */
export interface ScanProgressData {
  completedTasks: number;
  totalTasks: number;
  status: string;
}

/** ScopeFlag 到 ScanResourceType 的映射类型 */
export type ScopeToResourceMap = Record<ScopeFlag, ScanResourceType>;

/** POST /api/scan/start 响应体 */
export interface ScanStartResponse {
  scanJobId: string;
  batchId: string;
  status: string;
}

/* ------------------------------------------------------------------ */
/*  GET /api/scan/status 响应类型                                       */
/* ------------------------------------------------------------------ */

/** 单个 attempt 的精简状态 */
export interface ScanStatusAttempt {
  /** attempt ID */
  id: string;
  /** attempt 序号 */
  attemptNo: number;
  /** attempt 状态 */
  status: ScanTaskAttemptStatus;
  /** Shopify bulkOperationId */
  bulkOperationId: string | null;
  /** 已解析行数 */
  parsedRows: number;
  /** 最近解析错误 */
  lastParseError: string | null;
  /** attempt 开始时间 */
  startedAt: string;
  /** attempt 结束时间 */
  finishedAt: string | null;
}

/** 单个 task 的状态（含最新 attempt） */
export interface ScanStatusTask {
  /** task ID */
  id: string;
  /** 资源类型 */
  resourceType: ScanResourceType;
  /** task 状态 */
  status: ScanTaskStatus;
  /** 当前 attempt 序号 */
  currentAttemptNo: number;
  /** 最大尝试次数 */
  maxParseAttempts: number;
  /** task 开始时间 */
  startedAt: string;
  /** task 结束时间 */
  finishedAt: string | null;
  /** task 错误信息 */
  error: string | null;
  /** 最新 attempt，无 attempt 时为 null */
  latestAttempt: ScanStatusAttempt | null;
}

/** scan_job 总体状态 */
export interface ScanStatusJob {
  /** scan_job ID */
  scanJobId: string;
  /** 扫描总状态 */
  status: ScanJobStatus;
  /** 发布状态 */
  publishStatus: ScanJobPublishStatus;
  /** scope flags（快照） */
  scopeFlags: Record<string, boolean>;
  /** 成功的资源类型列表 */
  successfulResourceTypes: string[];
  /** 失败的资源类型列表 */
  failedResourceTypes: string[];
  /** 扫描开始时间 */
  startedAt: string;
  /** 扫描结束时间 */
  finishedAt: string | null;
  /** 发布时间 */
  publishedAt: string | null;
  /** 扫描错误信息 */
  error: string | null;
}

/** Redis 进度摘要（可选，Redis 键过期后为 null） */
export interface ScanProgressSummary {
  completedTasks: number;
  totalTasks: number;
  status: string;
  phase: string;
  message: string;
}

/** GET /api/scan/status 完整响应体 */
export interface ScanStatusResponse {
  /** scan_job 总状态 */
  scanJob: ScanStatusJob;
  /** task 列表（含各 task 最新 attempt） */
  tasks: ScanStatusTask[];
  /** Redis 进度摘要，键过期后为 null */
  progress: ScanProgressSummary | null;
  /** 前台应读取的 lastPublishedAt */
  lastPublishedAt: string | null;
}
