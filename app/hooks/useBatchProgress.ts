/**
 * File: app/hooks/useBatchProgress.ts
 * Purpose: 扫描进度聚合 Hook。
 *          整合 SSE 实时推送 + scan/status 初始恢复，
 *          为前端进度页提供统一的进度状态接口。
 *
 * 流程:
 *   1. 通过 scanJobId 从 GET /api/scan/status 恢复初始状态（刷新恢复）
 *   2. 连接 SSE 实时推送
 *   3. SSE 事件到达后覆盖进度数据
 *   4. 到达终态后停止 SSE
 */
import { useState, useEffect, useCallback } from "react";
import { useSSE, type SSEProgressData } from "./useSSE";
import { useScanStatus, type ScanStatusData } from "./useScanStatus";

/** 资源类型中文标签映射 */
const RESOURCE_TYPE_LABELS: Record<string, string> = {
  PRODUCT_MEDIA: "商品图片",
  FILES: "文件",
  COLLECTION_IMAGE: "合集图片",
  ARTICLE_IMAGE: "文章图片",
};

/** 进度阶段中文标签映射 */
const PHASE_LABELS: Record<string, string> = {
  started: "已启动",
  bulk_submitted: "查询已提交",
  parsing: "数据解析中",
  derive: "结果推导中",
  publish: "发布中",
  done: "已完成",
  failed: "失败",
  unknown: "未知",
};
const STATUS_POLL_INTERVAL_MS = 5_000;

function isTerminalPhase(phase: string | null | undefined): boolean {
  return phase === "done" || phase === "failed";
}

function isTerminalJobStatus(status: string | null | undefined): boolean {
  return status === "SUCCESS" || status === "PARTIAL_SUCCESS" || status === "FAILED";
}

function resolveTerminalPhaseFromJobStatus(status: string | null | undefined): string {
  if (status === "FAILED") {
    return "failed";
  }

  if (status === "SUCCESS" || status === "PARTIAL_SUCCESS") {
    return "done";
  }

  return "";
}

interface UseBatchProgressReturn {
  /** 实时进度（SSE 推送） */
  progress: SSEProgressData | null;
  /** 完整扫描状态（scan/status API） */
  scanStatus: ScanStatusData | null;
  /** 是否正在加载初始状态 */
  loading: boolean;
  /** 是否正在扫描中（非终态） */
  isScanning: boolean;
  /** 进度百分比 0-100 */
  percent: number;
  /** 阶段中文标签 */
  phaseLabel: string;
  /** 是否已完成（成功或失败） */
  isTerminal: boolean;
  /** 资源类型中文标签映射 */
  resourceTypeLabels: typeof RESOURCE_TYPE_LABELS;
  /** 阶段中文标签映射 */
  phaseLabels: typeof PHASE_LABELS;
  /** SSE 连接错误 */
  sseError: string | null;
  /** 重新扫描回调，成功时返回新的 scanJobId */
  handleRescan: () => Promise<string | null>;
  /** 重新扫描提交中 */
  rescanning: boolean;
  /** 重新扫描错误 */
  rescanError: string | null;
  /** 是否允许停止当前扫描 */
  canStop: boolean;
  /** 停止扫描回调 */
  handleStop: () => Promise<void>;
  /** 停止扫描提交中 */
  stopping: boolean;
  /** 停止扫描错误 */
  stopError: string | null;
}

/**
 * 扫描进度聚合 Hook。
 *
 * @param scanJobId 扫描任务 ID
 * @param onTerminal 可选回调，到达终态时触发
 */
export function useBatchProgress(
  scanJobId: string | null,
  onTerminal?: () => void,
): UseBatchProgressReturn {
  // 1. 初始状态恢复（页面刷新时使用）
  const { data: scanStatus, loading, refresh: refreshStatus } = useScanStatus(scanJobId);

  // 2. SSE 实时推送
  const { progress, connected, error: sseError } = useSSE(
    scanJobId,
    onTerminal,
  );

  // 3. 重新扫描状态
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // 4. 计算进度百分比
  const currentProgress = progress ?? scanStatus?.progress ?? null;
  const jobStatus = scanStatus?.scanJob?.status ?? null;
  const fallbackTerminalPhase = resolveTerminalPhaseFromJobStatus(jobStatus);
  const currentPhase = currentProgress?.phase ?? fallbackTerminalPhase;
  const percent =
    currentProgress && currentProgress.totalTasks > 0
      ? Math.round(
          (currentProgress.completedTasks / currentProgress.totalTasks) * 100,
        )
      : isTerminalJobStatus(jobStatus)
        ? 100
      : 0;

  // 5. 判断是否终态
  const isTerminal = isTerminalPhase(currentPhase) || isTerminalJobStatus(jobStatus);
  const isScanning = !!scanJobId && !isTerminal;

  // 6. 阶段中文标签
  const phaseLabel = PHASE_LABELS[currentPhase] ?? currentPhase;

  // 7. 重新扫描（返回新的 scanJobId 供调用方导航到进度页）
  const handleRescan = useCallback(async (): Promise<string | null> => {
    setRescanning(true);
    setRescanError(null);

    try {
      // 获取当前 scope flags 从 scanStatus
      const scopeFlags = scanStatus?.scanJob?.scopeFlags ?? {
        PRODUCT_MEDIA: true,
        FILES: true,
        COLLECTION_IMAGE: true,
        ARTICLE_IMAGE: true,
      };

      const response = await fetch("/api/scan/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopeFlags,
          noticeVersion: "1.3",
        }),
      });

      if (!response.ok) {
        const body = await response.json() as { error?: string };
        setRescanError(body.error ?? `请求失败 (${response.status})`);
        setRescanning(false);
        return null;
      }

      const result = await response.json() as { scanJobId?: string };
      setRescanning(false);
      return result.scanJobId ?? null;
    } catch {
      setRescanError("网络错误，请稍后重试");
      setRescanning(false);
      return null;
    }
  }, [scanStatus]);

  // 当 SSE 连接但 scanStatus 未加载时，使用 SSE 数据
  // 当 SSE 未连接（刷新恢复场景）时，使用 scanStatus 数据
  const effectiveProgress = progress ?? scanStatus?.progress ?? null;
  const effectivePhase = effectiveProgress?.phase ?? fallbackTerminalPhase;
  const effectiveIsTerminal =
    isTerminalPhase(effectivePhase) || isTerminalJobStatus(jobStatus);
  const effectivePercent =
    effectiveProgress && effectiveProgress.totalTasks > 0
      ? Math.round(
          (effectiveProgress.completedTasks / effectiveProgress.totalTasks) * 100,
        )
      : isTerminalJobStatus(jobStatus)
        ? 100
      : 0;
  const effectivePhaseLabel = PHASE_LABELS[effectivePhase] ?? effectivePhase;
  const effectiveIsScanning = !!scanJobId && !effectiveIsTerminal;
  const canStop = !!scanStatus &&
    scanStatus.scanJob.status === "RUNNING" &&
    scanStatus.tasks.length > 0 &&
    scanStatus.tasks.every((task) => task.status === "PENDING");

  useEffect(() => {
    if (!scanJobId || effectiveIsTerminal) {
      return;
    }

    const intervalId = window.setInterval(() => {
      refreshStatus();
    }, STATUS_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [effectiveIsTerminal, refreshStatus, scanJobId]);

  const handleStop = useCallback(async () => {
    if (!scanJobId) {
      return;
    }

    setStopping(true);
    setStopError(null);

    try {
      const response = await fetch("/api/scan/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanJobId }),
      });

      if (!response.ok) {
        const body = await response.json() as { error?: string };
        setStopError(body.error ?? `请求失败 (${response.status})`);
        setStopping(false);
        return;
      }

      // 停止成功，刷新状态即可，无需暴力 reload
      await refreshStatus();
      setStopping(false);
    } catch {
      setStopError("网络错误，请稍后重试");
      setStopping(false);
    }
  }, [refreshStatus, scanJobId]);

  return {
    progress: effectiveProgress as SSEProgressData | null,
    scanStatus,
    loading,
    isScanning: effectiveIsScanning,
    percent: effectivePercent,
    phaseLabel: effectivePhaseLabel,
    isTerminal: effectiveIsTerminal,
    resourceTypeLabels: RESOURCE_TYPE_LABELS,
    phaseLabels: PHASE_LABELS,
    sseError,
    handleRescan,
    rescanning,
    rescanError,
    canStop,
    handleStop,
    stopping,
    stopError,
  };
}
