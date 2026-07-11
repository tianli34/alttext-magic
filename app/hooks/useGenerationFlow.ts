/**
 * File: app/hooks/useGenerationFlow.ts
 * Purpose: 生成触发交互流程状态机 Hook。
 *          管理 候选选择 → 预检展示 → 确认生成 → 进度展示 → 完成/失败汇总 的完整状态。
 *
 * 流程阶段:
 *   IDLE → CONFIRMING（确认）→ STARTING → GENERATING → SUMMARY
 *   打开 CONFIRMING 弹窗时即后台执行 preflight 预检以展示当前额度余额；
 *   用户点确认时不再前端二次预检，直接投递生成，额度不足由后端原子预留兜底
 *   （返回 409 INSUFFICIENT_CREDIT），前端回填余额并停留 CONFIRMING 展示不足引导。
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useGenerationSSE, type GenerationProgressData } from "./useGenerationSSE";

// ============================================================================
// 进行中生成批次的本地持久化（用于刷新/路由跳转后的断点恢复）
//   仅保存 batchId 与总数；进度与汇总始终以 SSE 返回的快照为准。
//   服务端生成任务经 BullMQ 持久运行、Redis 保存进度快照，刷新不会丢失数据，
//   缺失的仅是「前端持有 batchId」这一环，故用 sessionStorage 补齐即可。
// ============================================================================

const ACTIVE_GENERATION_KEY = "alttext.activeGenerationBatch";

interface PersistedGeneration {
  /** 批次 ID */
  batchId: string;
  /** 总候选数（仅用于初始展示，实际以 SSE 快照为准） */
  totalCount: number;
}

/** 读取持久化的进行中生成批次（SSR/无 sessionStorage 时安全返回 null） */
function readPersistedGeneration(): PersistedGeneration | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_GENERATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedGeneration;
    if (!parsed || typeof parsed.batchId !== "string" || !parsed.batchId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** 持久化进行中生成批次 */
function persistGeneration(batchId: string, totalCount: number): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    const payload: PersistedGeneration = { batchId, totalCount };
    window.sessionStorage.setItem(ACTIVE_GENERATION_KEY, JSON.stringify(payload));
  } catch {
    // 忽略写入异常（如隐私模式禁用存储）
  }
}

/** 清除持久化的进行中生成批次 */
function clearPersistedGeneration(): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    window.sessionStorage.removeItem(ACTIVE_GENERATION_KEY);
  } catch {
    // 忽略清除异常
  }
}

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
  /** Preflight 预检进行中（用户已确认，正在检查额度） */
  preflightLoading: boolean;
  /** SSE 是否已连接 */
  connected: boolean;
  /** 进度百分比 0-100 */
  percent: number;
  /** 打开确认对话框（不发起预检，仅展示待生成数量） */
  openConfirm: (candidateIds: string[]) => void;
  /** 确认并启动生成（先预检额度，充足则投递任务） */
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
  const [preflightLoading, setPreflightLoading] = useState(false);
  const candidateIdsRef = useRef<string[]>([]);

  // 挂载后恢复进行中的生成批次（避免在 SSR/hydration 阶段读取 sessionStorage 引发不一致）
  useEffect(() => {
    const persisted = readPersistedGeneration();
    if (!persisted) return;
    setBatchId(persisted.batchId);
    setTotalCount(persisted.totalCount);
    setPhase("GENERATING");
  }, []);

  // SSE 完成回调：构造汇总并进入 SUMMARY，同时清除本地持久化的进行中批次
  const onCompleted = useCallback((data: GenerationProgressData) => {
    const succeeded = data.total - data.skipped - data.failed;
    setSummary({
      total: data.total,
      succeeded,
      skipped: data.skipped,
      failed: data.failed,
    });
    setPhase("SUMMARY");
    clearPersistedGeneration();
  }, []);

  // SSE 连接（仅在 GENERATING 阶段且有 batchId 时激活）
  const { progress, connected, percent } = useGenerationSSE(
    phase === "GENERATING" ? batchId : null,
    onCompleted,
  );

  // ---- 预检额度（鉴权 + 余额概览 + 消费规划）----
  // 供「打开弹窗即预检」与「确认时二次预检（防打开→确认间隙额度被消耗）」复用。
  const runPreflight = useCallback(async (): Promise<PreflightResult | null> => {
    setPreflightLoading(true);
    setError(null);

    try {
      const preflightResponse = await fetch("/api/generation/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: candidateIdsRef.current }),
      });

      if (!preflightResponse.ok) {
        const body = (await preflightResponse.json()) as { error?: string };
        throw new Error(body.error ?? `Preflight 请求失败 (${preflightResponse.status})`);
      }

      const preflightData = (await preflightResponse.json()) as PreflightResult;
      setPreflightResult(preflightData);
      return preflightData;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight 检查失败");
      return null;
    } finally {
      setPreflightLoading(false);
    }
  }, []);

  // ---- 打开确认对话框（立即弹出，并在后台预检额度以展示当前余额）----
  const openConfirm = useCallback((candidateIds: string[]) => {
    candidateIdsRef.current = candidateIds;
    setTotalCount(candidateIds.length);
    setPreflightResult(null);
    setError(null);
    setPhase("CONFIRMING");
    // 弹窗先渲染；额度在后台拉取，返回前显示「正在检查额度…」
    void runPreflight();
  }, [runPreflight]);

  // ---- 确认并启动生成 ----
  // 不再前端二次预检：/api/generation/start 内部已做原子额度预留兜底。
  // 若额度在打开→确认间隙被其他操作消耗，后端返回 409 INSUFFICIENT_CREDIT，
  // 此处用返回体回填 preflightResult 以在弹窗内展示余额不足引导卡片。
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
        const body = (await response.json()) as Partial<PreflightResult> & {
          error?: string;
          message?: string;
          code?: string;
        };

        // 额度不足 → 回填余额详情，停留确认弹窗展示不足引导（Upgrade / Buy Pack）
        if (response.status === 409 && body.error === "INSUFFICIENT_CREDIT") {
          setPreflightResult({
            estimatedCredits: body.estimatedCredits ?? candidateIdsRef.current.length,
            enough: false,
            includedRemaining: body.includedRemaining ?? 0,
            welcomeRemaining: body.welcomeRemaining ?? 0,
            overagePackRemaining: body.overagePackRemaining ?? 0,
            totalRemaining: body.totalRemaining ?? 0,
            currentPlan: body.currentPlan ?? "FREE",
            allocation: body.allocation ?? [],
          });
          setPhase("CONFIRMING");
          return;
        }

        const detail = body.message ? `${body.error}${body.code ? ` (${body.code})` : ""}: ${body.message}` : (body.error ?? `启动生成失败 (${response.status})`);
        throw new Error(detail);
      }

      const data = (await response.json()) as StartResult;
      setBatchId(data.batchId);
      setTotalCount(data.totalCount);
      // 持久化进行中批次，确保刷新/跳转后可恢复进度
      persistGeneration(data.batchId, data.totalCount);
      setPhase("GENERATING");
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动生成失败");
      setPhase("CONFIRMING");
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
    clearPersistedGeneration();
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
    preflightLoading,
    connected,
    percent,
    openConfirm,
    confirmAndStart,
    cancel,
    closeSummary,
  };
}
