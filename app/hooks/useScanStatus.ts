/**
 * File: app/hooks/useScanStatus.ts
 * Purpose: 扫描状态查询 Hook。
 *          通过 GET /api/scan/status?scanJobId=... 获取完整状态。
 *          用于页面刷新后恢复状态。
 */
import { useState, useEffect, useCallback } from "react";

/** 扫描任务状态（对应 ScanStatusTask） */
export interface ScanTaskStatus {
  id: string;
  resourceType: string;
  status: string;
  currentAttemptNo: number;
  maxParseAttempts: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  latestAttempt: {
    id: string;
    attemptNo: number;
    status: string;
    bulkOperationId: string | null;
    parsedRows: number;
    lastParseError: string | null;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}

/** 扫描 Job 状态 */
export interface ScanJobStatus {
  scanJobId: string;
  status: string;
  publishStatus: string;
  scopeFlags: Record<string, boolean>;
  successfulResourceTypes: string[];
  failedResourceTypes: string[];
  startedAt: string;
  finishedAt: string | null;
  publishedAt: string | null;
  error: string | null;
}

/** GET /api/scan/status 完整响应 */
export interface ScanStatusData {
  scanJob: ScanJobStatus;
  tasks: ScanTaskStatus[];
  progress: {
    completedTasks: number;
    totalTasks: number;
    status: string;
    phase: string;
    message: string;
  } | null;
  lastPublishedAt: string | null;
}

interface UseScanStatusReturn {
  /** 扫描状态数据 */
  data: ScanStatusData | null;
  /** 是否加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 手动刷新 */
  refresh: () => void;
}

/**
 * 扫描状态查询 Hook。
 *
 * @param scanJobId 扫描任务 ID，null 时不请求
 */
export function useScanStatus(scanJobId: string | null): UseScanStatusReturn {
  const [data, setData] = useState<ScanStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!scanJobId) {
      setData(null);
      return;
    }

    let cancelled = false;

    async function fetchStatus() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/scan/status?scanJobId=${encodeURIComponent(scanJobId!)}`,
        );

        if (!response.ok) {
          const body = await response.json() as { error?: string };
          if (!cancelled) {
            setError(body.error ?? `请求失败 (${response.status})`);
          }
          return;
        }

        const result = await response.json() as ScanStatusData;
        if (!cancelled) {
          setData(result);
        }
      } catch {
        if (!cancelled) {
          setError("网络错误，请稍后重试");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchStatus();

    return () => {
      cancelled = true;
    };
  }, [scanJobId, refreshKey]);

  return { data, loading, error, refresh };
}
