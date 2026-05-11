/**
 * File: server/modules/dashboard/dashboard.types.ts
 * Purpose: GET /api/dashboard 返回体与内部统计类型。
 */
import type { CandidateGroupType } from "@prisma/client";

export interface DashboardGroupStats {
  groupType: CandidateGroupType;
  total: number;
  hasAlt: number;
  missing: number;
  decorative: number;
}

export interface DashboardData {
  groups: DashboardGroupStats[];
  lastPublishedAt: string | null;
  isScanning: boolean;
  /** 当前运行中的扫描任务 ID（用于导航到进度页） */
  activeScanJobId: string | null;
}

