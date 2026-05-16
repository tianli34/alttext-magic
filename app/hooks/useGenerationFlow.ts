/**
 * File: app/hooks/useGenerationFlow.ts
 * Purpose: 生成触发交互流程状态机 Hook。
 *          管理 候选选择 → 预检展示 → 确认生成 → 进度展示 → 完成/失败汇总 的完整状态。
 *
 * 流程阶段:
 *   IDLE → PREFLIGHT_LOADING → CONFIRMING → STARTING → GENERATING → SUMMARY
 */
import { useState, useCallback, useRef } from "react";
import { useGenerationSSE, type GenerationProgressData } from "./useGenerationSSE";

// ============================================================================
// 类型定义
// ============================================================================

/** 生成流程阶段 */
export type GenerationFlowPhase =
  | "IDLE"
  | "PREFLIGHT_LOADING"
  | "CONFIRMING"
  | "STARTING"
  | "GENERATING"
  | "SUMMARY";

/** Preflight 响应体（与 api.generation.preflight 对齐） */
export interface PreflightResult {
  estimatedCredits: number;
  enough: boolean;
  includedRemaining: number;
  welcomeRemaining: number;
  overagePackRemaining: number;
  totalRemaining: number;
  currentPlan: string;
  allocation: Array<{ bucketType: string; amount: number }>;
}

/** generation/start 响应体 */
interface StartResult {
  batchId: string;
  totalCount: number;
}

/** 汇总数据（由 SSE 终态事件或手动构造） */
export interface GenerationSummary {
  /** 总处理数 */
  total: number;
  /** 成功数 */
  succeeded: number;
  /** 跳过数（已有 Alt） */
  skipped: number;
  /** 失败数 */
  failed: number;
}

interface UseGenerationFlowReturn {
  /** 当前阶段 */
  phase: GenerationFlowPhase;
  /** Preflight 结果 */
  preflightResult: PreflightResult | null;
  /** 批次 ID */
  batchId: string | null;
  /** 总候选数 */
  totalCount: number;
  /** SSE 实时进度数据 */
  progress: GenerationProgressData | null;
  /** 汇总数据（SUMMARY 阶段） */
  summary: GenerationSummary | null;
  /** 错误信息 */
  error: string | null;
  /** SSE 是否已连接 */
  connected: boolean;
  /** 进度百分比 0-100 */
  percent: number;
  /** 发起 Preflight 检查 */
  startPreflight: (candidateIds: string[]) => Promise<void>;
  /** 确认并启动生成 */
  confirmAndStart: () => Promise<void>;
  /** 取消流程（从任意非 GENERATING 阶段回到 IDLE） */
  cancel: () => void;
  /** 关闭汇总（回到 IDLE） */
  closeSummary: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useGenerationFlow(): UseGenerationFlowReturn {
  const [phase, setPhase] = useState<GenerationFlowPhase>("IDLE");
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState<GenerationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const candidateIdsRef = useRef<string[]>([]);

  // SSE 完成回调：构造汇总并进入 SUMMARY
  const onCompleted = useCallback((data: GenerationProgressData) => {
    const succeeded = data.total - data.skipped - data.failed;
    setSummary({
      total: data.total,
      succeeded,
      skipped: data.skipped,
      failed: data.failed,
    });
    setPhase("SUMMARY");
  }, []);

  // SSE 连接（仅在 GENERATING 阶段且有 batchId 时激活）
  const { progress, connected, percent } = useGenerationSSE(
    phase === "GENERATING" ? batchId : null,
    onCompleted,
  );

  // ---- Preflight ----
  const startPreflight = useCallback(async (candidateIds: string[]) => {
    candidateIdsRef.current = candidateIds;
    setPhase("PREFLIGHT_LOADING");
    setError(null);
    setPreflightResult(null);

    try {
      const response = await fetch("/api/generation/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? `Preflight 请求失败 (${response.status})`);
      }

      const data = (await response.json()) as PreflightResult;
      setPreflightResult(data);
      setTotalCount(candidateIds.length);
      setPhase("CONFIRMING");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight 检查失败");
      setPhase("IDLE");
    }
  }, []);

  // ---- Start Generation ----
  const confirmAndStart = useCallback(async () => {
    setPhase("STARTING");
    setError(null);

    try {
      const response = await fetch("/api/generation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: candidateIdsRef.current }),
      });

      if (!response.ok) {
        const body = (await response.json()) as { error?: string; message?: string };
        throw new Error(body.error ?? body.message ?? `启动生成失败 (${response.status})`);
      }

      const data = (await response.json()) as StartResult;
      setBatchId(data.batchId);
      setTotalCount(data.totalCount);
      setPhase("GENERATING");
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动生成失败");
      setPhase("IDLE");
    }
  }, []);

  // ---- Cancel ----
  const cancel = useCallback(() => {
    setPhase("IDLE");
    setPreflightResult(null);
    setError(null);
  }, []);

  // ---- Close Summary ----
  const closeSummary = useCallback(() => {
    setPhase("IDLE");
    setPreflightResult(null);
    setBatchId(null);
    setSummary(null);
    setTotalCount(0);
    setError(null);
    candidateIdsRef.current = [];
  }, []);

  return {
    phase,
    preflightResult,
    batchId,
    totalCount,
    progress,
    summary,
    error,
    connected,
    percent,
    startPreflight,
    confirmAndStart,
    cancel,
    closeSummary,
  };
}
