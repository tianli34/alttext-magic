/**
 * File: server/modules/scan/scan.types.ts
 * Purpose: 扫描模块的共享类型定义。
 */
import type { ScanResourceType, ScanJobStatus, ScanTaskStatus } from "@prisma/client";
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
