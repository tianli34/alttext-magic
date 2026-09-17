/**
 * File: app/hooks/useGenerationFlow.ts
 * Purpose: 生成触发交互流程状态机 Hook。
 *          管理 候选选择 → 预检展示 → 确认生成 → 生成进度 → 自动写回进度 → 完成汇总 的完整状态。
 *
 * 流程阶段:
 *   IDLE → CONFIRMING（确认）→ STARTING → GENERATING → WRITEBACK → SUMMARY
 *   打开 CONFIRMING 弹窗时即后台执行 preflight 预检以展示当前额度余额；
 *   用户点确认时不再前端二次预检，直接投递生成，额度不足由后端原子预留兜底
 *   （返回 409 INSUFFICIENT_CREDIT），前端回填余额并停留 CONFIRMING 展示不足引导。
 *   生成收尾后服务端自动触发写回（审阅环节已砍掉），前端经生成进度事件中的
 *   writebackBatchId 无缝转入 WRITEBACK 阶段展示写回进度，最终合并汇总。
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useGenerationSSE, type GenerationProgressData } from "./useGenerationSSE";
import { useWritebackSSE, type WritebackProgressData } from "./useWritebackSSE";

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
  /** 自动触发的写回批次 ID（已转入写回阶段时存在） */
  writebackBatchId?: string | null;
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
function persistGeneration(batchId: string, totalCount: number, writebackBatchId?: string | null): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    const payload: PersistedGeneration = { batchId, totalCount, writebackBatchId: writebackBatchId ?? null };
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
  | "WRITEBACK"
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
  /** 自动写回结果（无需写回/未能启动时为 null） */
  writeback: {
    /** 写回批次 ID */
    batchId: string;
    /** 写回总条数 */
    total: number;
    /** 写回成功数 */
    success: number;
    /** 写回失败数 */
    fail: number;
    /** 写回跳过数（已有 Alt） */
    skip: number;
    /** 写回待处理数（终态时应为 0） */
    pending: number;
  } | null;
  /** 自动写回未能启动时的错误码（成功时为 null） */
  writebackError?: string | null;
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
  /** 自动触发的写回批次 ID */
  writebackBatchId: string | null;
  /** 写回 SSE 实时进度数据 */
  writebackProgress: WritebackProgressData | null;
  /** 写回 SSE 是否已连接 */
  writebackConnected: boolean;
  /** 写回 SSE 连接错误 */
  writebackError: string | null;
  /** 写回进度百分比 0-100 */
  writebackPercent: number;
  /** 自动写回未能启动时的错误码 */
  autoWritebackError: string | null;
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
  const [writebackBatchId, setWritebackBatchId] = useState<string | null>(null);
  const [autoWritebackError, setAutoWritebackError] = useState<string | null>(null);
  const candidateIdsRef = useRef<string[]>([]);
  // 生成计数的暂存：转入 WRITEBACK 阶段后用于合并最终汇总。
  const generationTallyRef = useRef<{ total: number; succeeded: number; skipped: number; failed: number } | null>(null);

  // 挂载后恢复进行中的生成批次（避免在 SSR/hydration 阶段读取 sessionStorage 引发不一致）
  useEffect(() => {
    const persisted = readPersistedGeneration();
    if (!persisted) return;
    setBatchId(persisted.batchId);
    setTotalCount(persisted.totalCount);
    if (persisted.writebackBatchId) {
      setWritebackBatchId(persisted.writebackBatchId);
      setPhase("WRITEBACK");
    } else {
      setPhase("GENERATING");
    }
  }, []);

  // 生成 SSE 完成回调：有自动写回批次则转入 WRITEBACK，否则直接汇总。
  const onGenerationCompleted = useCallback((data: GenerationProgressData) => {
    const succeeded = data.total - data.skipped - data.failed;
    const tally = {
      total: data.total,
      succeeded,
      skipped: data.skipped,
      failed: data.failed,
    };
    const linkedWritebackBatchId = data.writebackBatchId ?? null;
    const linkedWritebackError = data.writebackError ?? null;

    if (linkedWritebackBatchId) {
      generationTallyRef.current = tally;
      setWritebackBatchId(linkedWritebackBatchId);
      setAutoWritebackError(linkedWritebackError);
      if (batchId) persistGeneration(batchId, data.total, linkedWritebackBatchId);
      setPhase("WRITEBACK");
      return;
    }

    setSummary({ ...tally, writeback: null, writebackError: linkedWritebackError });
    setPhase("SUMMARY");
    clearPersistedGeneration();
  }, [batchId]);

  // SSE 连接（仅在 GENERATING 阶段且有 batchId 时激活）
  const { progress, connected, percent } = useGenerationSSE(
    phase === "GENERATING" ? batchId : null,
    onGenerationCompleted,
  );

  // 写回 SSE 完成回调：合并生成计数与写回计数后进入 SUMMARY。
  const onWritebackCompleted = useCallback((data: WritebackProgressData) => {
    const tally = generationTallyRef.current;
    setSummary({
      total: tally?.total ?? data.total,
      succeeded: tally?.succeeded ?? 0,
      skipped: tally?.skipped ?? 0,
      failed: tally?.failed ?? 0,
      writeback: {
        batchId: data.batchId,
        total: data.total,
        success: data.success,
        fail: data.fail,
        skip: data.skip,
        pending: data.pending,
      },
      writebackError: null,
    });
    generationTallyRef.current = null;
    setPhase("SUMMARY");
    clearPersistedGeneration();
  }, []);

  // 写回 SSE 连接（仅在 WRITEBACK 阶段且有 writebackBatchId 时激活）
  const {
    progress: writebackProgress,
    connected: writebackConnected,
    error: writebackError,
    percent: writebackPercent,
  } = useWritebackSSE(
    phase === "WRITEBACK" ? writebackBatchId : null,
    onWritebackCompleted,
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
  // 从 WRITEBACK 取消仅关闭前端展示，服务端自动写回继续执行（结果可在历史页查看）。
  const cancel = useCallback(() => {
    clearPersistedGeneration();
    generationTallyRef.current = null;
    setPhase("IDLE");
    setPreflightResult(null);
    setBatchId(null);
    setWritebackBatchId(null);
    setAutoWritebackError(null);
    setError(null);
  }, []);

  // ---- Close Summary ----
  const closeSummary = useCallback(() => {
    clearPersistedGeneration();
    generationTallyRef.current = null;
    setPhase("IDLE");
    setPreflightResult(null);
    setBatchId(null);
    setWritebackBatchId(null);
    setAutoWritebackError(null);
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
    writebackBatchId,
    writebackProgress,
    writebackConnected,
    writebackError,
    writebackPercent,
    autoWritebackError,
    openConfirm,
    confirmAndStart,
    cancel,
    closeSummary,
  };
}
