/**
 * File: app/hooks/useGenerationFlow.ts
 * Purpose: 生成触发交互流程状态机 Hook。
 *          管理 候选选择 → 预检展示 → 确认生成 → 生成进度 → 自动写回进度 → 完成汇总 的完整状态。
 *
 * 流程阶段:
 *   IDLE → CONFIRMING（确认）→ STARTING → GENERATING → WRITEBACK → SUMMARY
 *   Dashboard 一键处理先进入 PREFLIGHT_LOADING 占位弹窗（后台统计候选 ID），
 *   统计完成后转入 CONFIRMING（或仅写回时直入 STARTING），失败/无候选则停留展示错误；
 *   打开 CONFIRMING 弹窗时即后台执行 preflight 预检以展示当前额度余额；
 *   用户点确认时不再前端二次预检，直接投递生成，额度不足由后端原子预留兜底
 *   （返回 409 INSUFFICIENT_CREDIT），前端回填余额并停留 CONFIRMING 展示不足引导。
 *   生成收尾后服务端自动触发写回（审阅环节已砍掉），前端经生成进度事件中的
 *   writebackBatchId 无缝转入 WRITEBACK 阶段展示写回进度，最终合并汇总。
 */
import { useState, useCallback, useRef, useEffect } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useGenerationSSE, type GenerationProgressData } from "./useGenerationSSE";
import { useWritebackSSE, type WritebackProgressData } from "./useWritebackSSE";
import {
  useWritebackTruthDebug,
  type WritebackTruthDebugEvent,
} from "./useWritebackTruthDebug";
import {
  type GenerationTally,
  hydrateGenerationTallyWithRetry,
  isGenerationTally,
  toGenerationTally,
} from "../lib/generation-tally";
import {
  extractResponseError,
  parseJsonResponse,
} from "../lib/http-error";

// ============================================================================
// 进行中生成批次的本地持久化（用于刷新/路由跳转后的断点恢复）
//   保存 batchId 与总数；转入写回阶段时连同生成计数一并存入（与写回对齐），
//   彻底避免刷新恢复后因网络竞态导致生成计数缺失呈现未知占位符。
// ============================================================================

const ACTIVE_GENERATION_KEY = "alttext.activeGenerationBatch";

interface PersistedGeneration {
  /** 批次 ID */
  batchId: string;
  /** 总候选数（仅用于初始展示，实际以 SSE 快照为准） */
  totalCount: number;
  /** 自动触发的写回批次 ID（已转入写回阶段时存在） */
  writebackBatchId?: string | null;
  /** 生成计数（已转入写回阶段时存在，使生成与写回行为对齐，刷新后直接同步还原） */
  generationTally?: GenerationTally | null;
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
    const generationTally = isGenerationTally(parsed.generationTally)
      ? parsed.generationTally
      : null;
    return {
      batchId: parsed.batchId,
      totalCount: typeof parsed.totalCount === "number" ? parsed.totalCount : 0,
      writebackBatchId: parsed.writebackBatchId ?? null,
      generationTally,
    };
  } catch {
    return null;
  }
}

/** 持久化进行中生成批次 */
function persistGeneration(
  batchId: string,
  totalCount: number,
  writebackBatchId?: string | null,
  generationTally?: GenerationTally | null,
): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    const payload: PersistedGeneration = {
      batchId,
      totalCount,
      writebackBatchId: writebackBatchId ?? null,
      generationTally: generationTally ?? null,
    };
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
// 恢复路径的生成计数回填参数（取数策略见 app/lib/generation-tally.ts）
// ============================================================================

/** 写回终态回调等待回填的上限：生成端点长期故障时先出汇总（占位符），回填成功后原地补数 */
const GENERATION_TALLY_WAIT_CAP_MS = 15_000;

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
  /**
   * 成功数（派生量：total - skipped - failed，非服务端权威字段）。
   * null 表示生成阶段计数无法取得（如刷新恢复路径回填失败），
   * UI 必须以占位符呈现，不得退化成 0 造成「生成成功 0 / 写回成功 94」的错觉。
   */
  succeeded: number | null;
  /** 跳过数（已有 Alt），null 语义同 succeeded */
  skipped: number | null;
  /** 失败数，null 语义同 succeeded */
  failed: number | null;
  /**
   * 本次流程是否运行过生成阶段。
   * false 只出现在「仅写回」的一键处理：没有生成候选，全程只有写回批次，
   * 生成侧三项本就不存在（而非取不到）。UI 据此不渲染生成结果卡片与
   * 「计数未能取得」提示，也不得让恒为 null 的生成侧计数把成功的写回
   * 拖成失败判定。
   */
  generationRan: boolean;
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
  /** 真值复核调试事件（仅 WRITEBACK_TRUTH_DEBUG=true 时有数据，调试专用） */
  truthDebugEvents: WritebackTruthDebugEvent[];
  /** 真值复核调试 SSE 是否已连接 */
  truthDebugConnected: boolean;
  /** 真值复核调试端点不可用（开关关闭/批次不存在），调用方据此不渲染调试弹窗 */
  truthDebugDisabled: boolean;
  /** 打开确认对话框（不发起预检，仅展示待生成数量） */
  openConfirm: (candidateIds: string[]) => void;
  /** 打开一键处理准备弹窗（立即反馈，候选统计请求由调用方在弹窗打开后发起） */
  openQuickProcessPrepare: () => void;
  /** 一键处理统计失败或无候选：停留准备弹窗展示错误，用户可关闭 */
  failQuickProcessPrepare: (message: string) => void;
  /** 打开 Dashboard 一键处理确认：写回项会与生成任务一并启动 */
  openQuickProcess: (generationCandidateIds: string[], writebackCandidateIds: string[]) => void;
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
  const shopify = useAppBridge();
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
  const writebackCandidateIdsRef = useRef<string[]>([]);
  const startedQuickWritebackBatchIdRef = useRef<string | null>(null);
  // 生成计数的暂存：转入 WRITEBACK 阶段后用于合并最终汇总。
  const generationTallyRef = useRef<{ total: number; succeeded: number; skipped: number; failed: number } | null>(null);
  // 已组装过汇总的写回批次 ID。
  // 写回终态快照有 SSE 与轮询两条通道，同一批次可能先后送达两次（见 useWritebackSSE
  // 的轮询会话代号说明）。本回调在组装后即清空 generationTallyRef 与本地缓存，
  // 若放行第二次组装，已取得的生成计数会被覆盖成 null——界面留下
  // 「生成阶段计数未能取得」，而写回三格照旧有数（数字来自第二次载荷）。
  // 批次 ID 每次运行都不同，故按 ID 记账即可，无需在收尾时清除。
  const summarizedWritebackBatchIdRef = useRef<string | null>(null);
  // 刷新恢复路径的计数回填 Promise（重试直至成功的循环，见 hydrateGenerationTally）：
  // 写回终态回调可能先于回填成功，此时等待其落地（带上限）再构造汇总，
  // 避免把「尚未取得」误判为「未知」。
  const pendingGenerationTallyRef = useRef<Promise<void> | null>(null);
  // 回填循环的会话代号：恢复 effect 重入（StrictMode 卸载重挂）与 teardown
  // （cancel/closeSummary/组件卸载）时递增；循环每次落状态前核对，失效即退出，
  // 防止旧循环在后台无限轮询或向已关闭的流程写入上一批次的计数。
  const generationTallyRunIdRef = useRef(0);

  /**
   * 刷新恢复路径的生成计数回填。
   *
   * 恢复时直接进 WRITEBACK 阶段，useGenerationSSE 不再激活（其入参 batchId 为 null），
   * 生成终态回调不会触发 → 内存 tally 恒为 null → 汇总里「生成成功」被兜底成 0，
   * 与写回成功的真实计数自相矛盾。此处经 hydrateGenerationTallyWithRetry 轮询
   * 与生成进度同口径的快照补回该派生量（失败静默、重试直至成功，策略见 lib）；
   * 取不到时保持 null（UI 显示占位符），不伪造 0。
   *
   * @param runId 回填会话代号：与 generationTallyRunIdRef 当前值不符即视为已 teardown
   */
  const hydrateGenerationTally = useCallback(async (generationBatchId: string, runId: number): Promise<void> => {
    await hydrateGenerationTallyWithRetry({
      fetchSnapshot: async () => {
        const token = await shopify.idToken();
        return fetch(`/api/generation/batch/${encodeURIComponent(generationBatchId)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      },
      onTally: (tally) => {
        generationTallyRef.current = tally;
        // 兜底回填成功时补写进本地存储，防御写回阶段后续再次刷新
        const persisted = readPersistedGeneration();
        if (persisted && persisted.batchId === generationBatchId && persisted.writebackBatchId) {
          persistGeneration(
            persisted.batchId,
            persisted.totalCount,
            persisted.writebackBatchId,
            tally,
          );
        }
        // 汇总若已先于回填落地（等待上限兜底放行），把占位符原地补成真实计数
        setSummary((prev) =>
          prev && prev.succeeded === null
            ? {
                ...prev,
                total: tally.total,
                succeeded: tally.succeeded,
                skipped: tally.skipped,
                failed: tally.failed,
              }
            : prev,
        );
      },
      isCancelled: () => generationTallyRunIdRef.current !== runId,
    });
  }, [shopify]);

  // 挂载后恢复进行中的生成批次（避免在 SSR/hydration 阶段读取 sessionStorage 引发不一致）
  useEffect(() => {
    const persisted = readPersistedGeneration();
    if (!persisted) return;
    setBatchId(persisted.batchId);
    setTotalCount(persisted.totalCount);
    if (persisted.writebackBatchId) {
      setWritebackBatchId(persisted.writebackBatchId);
      setPhase("WRITEBACK");
      // 若本地持久化已持有生成计数（与写回对齐），直接恢复到内存，无需等待或发起网络回填
      if (persisted.generationTally) {
        generationTallyRef.current = persisted.generationTally;
        pendingGenerationTallyRef.current = null;
      } else {
        // 兜底（兼容未持久化 tally 的旧会话或降级）：启动异步回填循环（重试直至成功）
        const runId = ++generationTallyRunIdRef.current;
        pendingGenerationTallyRef.current = hydrateGenerationTally(persisted.batchId, runId);
      }
    } else {
      setPhase("GENERATING");
    }
    // 卸载/重入时递增代号，使仍在重试的回填循环立即退出
    return () => {
      generationTallyRunIdRef.current += 1;
    };
  }, [hydrateGenerationTally]);

  // 生成 SSE 完成回调：有自动写回批次则转入 WRITEBACK，否则直接汇总。
  const onGenerationCompleted = useCallback((data: GenerationProgressData) => {
    // 派生口径与 worker 一致（total - skipped - failed），统一走 toGenerationTally，
    // 避免此处与刷新恢复路径两处各写一套算法导致口径漂移
    const tally = toGenerationTally({
      total: data.total,
      skipped: data.skipped,
      failed: data.failed,
    });
    const linkedWritebackBatchId = data.writebackBatchId ?? null;
    const linkedWritebackError = data.writebackError ?? null;

    if (linkedWritebackBatchId) {
      generationTallyRef.current = tally;
      // 本会话已经拿到权威生成计数，恢复路径的回填（若有）不再需要等待
      pendingGenerationTallyRef.current = null;
      setWritebackBatchId(linkedWritebackBatchId);
      setAutoWritebackError(linkedWritebackError);
      if (batchId) persistGeneration(batchId, data.total, linkedWritebackBatchId, tally);
      setPhase("WRITEBACK");
      return;
    }

    pendingGenerationTallyRef.current = null;
    setSummary({ ...tally, writeback: null, writebackError: linkedWritebackError, generationRan: true });
    setPhase("SUMMARY");
    clearPersistedGeneration();
  }, [batchId]);

  // SSE 连接（仅在 GENERATING 阶段且有 batchId 时激活）
  const { progress, connected, percent } = useGenerationSSE(
    phase === "GENERATING" ? batchId : null,
    onGenerationCompleted,
  );

  // 写回 SSE 完成回调：合并生成计数与写回计数后进入 SUMMARY。
  // 生成计数缺失（刷新恢复且回填失败）时以 null 呈递，由 UI 显示占位符——
  // 写回计数来自 job_batch 权威计数，即使生成侧未知也照常展示。
  // 若恢复路径的计数回填仍在进行（写回批次可能已完成，终态回调抢先到达），
  // 先等它落地再构造汇总，避免把「尚未取得」误判为「未知」。
  const onWritebackCompleted = useCallback((data: WritebackProgressData) => {
    // 同一写回批次只组装一次汇总：终态回调可能被两条通道各送一次，
    // 第二次到达时生成计数已被上一次清空，组装结果会把已知数字盖成未知
    if (summarizedWritebackBatchIdRef.current === data.batchId) return;
    summarizedWritebackBatchIdRef.current = data.batchId;

    // 「本次流程是否运行过生成阶段」：batchId 只在生成流程中被写入
    // （confirmAndStart 的生成分支与刷新恢复），仅写回的一键处理全程为 null。
    // 从依赖取值而非 ref 镜像，避免在渲染期写 ref（见本 Hook 的 ref 使用约定）。
    const generationRan = batchId !== null;

    void (async () => {
      const pendingHydration = pendingGenerationTallyRef.current;
      if (generationTallyRef.current === null && pendingHydration) {
        // 回填是「重试直至成功」的循环，通常数秒内落地；等待设上限：
        // 生成端点长期故障时不得无限期阻塞汇总，先以占位符呈现，
        // 回填成功后由循环的 onTally 原地补数
        await Promise.race([
          pendingHydration.catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, GENERATION_TALLY_WAIT_CAP_MS)),
        ]);
      }

      const tally = generationTallyRef.current;
      setSummary({
        total: tally?.total ?? data.total,
        succeeded: tally?.succeeded ?? null,
        skipped: tally?.skipped ?? null,
        failed: tally?.failed ?? null,
        generationRan,
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
      pendingGenerationTallyRef.current = null;
      setPhase("SUMMARY");
      clearPersistedGeneration();
    })();
    // batchId 参与依赖仅为取用「是否运行过生成阶段」快照：本回调只被
    // useWritebackSSE 存进 ref 后调用，身份变化不会重连 SSE 或重启轮询。
  }, [batchId]);

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

  // 真值复核调试 SSE（仅在 WRITEBACK 阶段激活；服务端开关关闭时 disabled）
  const {
    events: truthDebugEvents,
    connected: truthDebugConnected,
    disabled: truthDebugDisabled,
  } = useWritebackTruthDebug(
    phase === "WRITEBACK" ? writebackBatchId : null,
  );

  // ---- 预检额度（鉴权 + 余额概览 + 消费规划）----
  // 供「打开弹窗即预检」与「确认时二次预检（防打开→确认间隙额度被消耗）」复用。
  const runPreflight = useCallback(async (): Promise<PreflightResult | null> => {
    setPreflightLoading(true);
    setError(null);

    try {
      // 嵌入式 iframe 下 cookie 会话可能被拦，与 SSE/回填通道一致显式携带会话令牌
      const token = await shopify.idToken();
      const preflightResponse = await fetch("/api/generation/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidateIds: candidateIdsRef.current }),
      });

      if (!preflightResponse.ok) {
        throw new Error(await extractResponseError(preflightResponse));
      }

      const preflightData = await parseJsonResponse<PreflightResult>(preflightResponse);
      setPreflightResult(preflightData);
      return preflightData;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preflight 检查失败");
      return null;
    } finally {
      setPreflightLoading(false);
    }
  }, [shopify]);

  // ---- 打开确认对话框（立即弹出，并在后台预检额度以展示当前余额）----
  const openConfirm = useCallback((candidateIds: string[]) => {
    candidateIdsRef.current = candidateIds;
    writebackCandidateIdsRef.current = [];
    startedQuickWritebackBatchIdRef.current = null;
    setTotalCount(candidateIds.length);
    setPreflightResult(null);
    setError(null);
    setPhase("CONFIRMING");
    // 弹窗先渲染；额度在后台拉取，返回前显示「正在检查额度…」
    void runPreflight();
  }, [runPreflight]);

  // ---- 打开一键处理准备弹窗（立即弹出，候选统计请求由调用方随后发起）----
  const openQuickProcessPrepare = useCallback(() => {
    candidateIdsRef.current = [];
    writebackCandidateIdsRef.current = [];
    startedQuickWritebackBatchIdRef.current = null;
    setPreflightResult(null);
    setError(null);
    setPhase("PREFLIGHT_LOADING");
  }, []);

  // ---- 一键处理统计失败/无候选：停留准备弹窗展示错误，用户可点关闭回到 IDLE ----
  const failQuickProcessPrepare = useCallback((message: string) => {
    setError(message);
  }, []);

  const openQuickProcess = useCallback((generationCandidateIds: string[], writebackCandidateIds: string[]) => {
    candidateIdsRef.current = generationCandidateIds;
    writebackCandidateIdsRef.current = writebackCandidateIds;
    startedQuickWritebackBatchIdRef.current = null;
    setTotalCount(generationCandidateIds.length);
    setPreflightResult(null);
    setError(null);
    setPhase(generationCandidateIds.length > 0 ? "CONFIRMING" : "STARTING");
    if (generationCandidateIds.length > 0) {
      void runPreflight();
    }
  }, [runPreflight]);

  // ---- 确认并启动生成 ----
  // 不再前端二次预检：/api/generation/start 内部已做原子额度预留兜底。
  // 若额度在打开→确认间隙被其他操作消耗，后端返回 409 INSUFFICIENT_CREDIT，
  // 此处用返回体回填 preflightResult 以在弹窗内展示余额不足引导卡片。
  const confirmAndStart = useCallback(async () => {
    setPhase("STARTING");
    setError(null);

    try {
      // 同 runPreflight：显式携带会话令牌，不依赖 iframe 内 cookie 会话
      const token = await shopify.idToken();
      let startedWritebackBatchId = startedQuickWritebackBatchIdRef.current;
      if (!startedWritebackBatchId && writebackCandidateIdsRef.current.length > 0) {
        const writebackResponse = await fetch("/api/writeback/start", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ candidateIds: writebackCandidateIdsRef.current }),
        });
        if (!writebackResponse.ok) {
          throw new Error(await extractResponseError(writebackResponse));
        }
        const writebackData = await parseJsonResponse<{ batchId: string }>(writebackResponse);
        startedWritebackBatchId = writebackData.batchId;
        startedQuickWritebackBatchIdRef.current = startedWritebackBatchId;
      }

      if (candidateIdsRef.current.length === 0) {
        if (!startedWritebackBatchId) {
          setError("当前没有可处理的图片");
          setPhase("IDLE");
          return;
        }
        setWritebackBatchId(startedWritebackBatchId);
        setPhase("WRITEBACK");
        return;
      }

      const response = await fetch("/api/generation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ candidateIds: candidateIdsRef.current }),
      });

      if (!response.ok) {
        // 409 余额不足分支需要解析结构化余额字段；非 JSON 响应体（HTML 错误页）
        // 由 parseJsonResponse 转成带状态码与片段的错误，不再漏出浏览器原生报错
        const body = await parseJsonResponse<Partial<PreflightResult> & {
          error?: string;
          message?: string;
          code?: string;
        }>(response);

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

      const data = await parseJsonResponse<StartResult>(response);
      setBatchId(data.batchId);
      setTotalCount(data.totalCount);
      // 持久化进行中批次，确保刷新/跳转后可恢复进度
      persistGeneration(data.batchId, data.totalCount);
      setPhase("GENERATING");
    } catch (err) {
      setError(err instanceof Error ? err.message : "启动生成失败");
      setPhase("CONFIRMING");
    }
  }, [shopify]);

  // ---- Cancel ----
  // 从 WRITEBACK 取消仅关闭前端展示，服务端自动写回继续执行（结果可在历史页查看）。
  const cancel = useCallback(() => {
    clearPersistedGeneration();
    generationTallyRunIdRef.current += 1; // 使仍在重试的回填循环立即退出
    generationTallyRef.current = null;
    pendingGenerationTallyRef.current = null;
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
    generationTallyRunIdRef.current += 1; // 使仍在重试的回填循环立即退出
    generationTallyRef.current = null;
    pendingGenerationTallyRef.current = null;
    setPhase("IDLE");
    setPreflightResult(null);
    setBatchId(null);
    setWritebackBatchId(null);
    setAutoWritebackError(null);
    setSummary(null);
    setTotalCount(0);
    setError(null);
    candidateIdsRef.current = [];
    writebackCandidateIdsRef.current = [];
    startedQuickWritebackBatchIdRef.current = null;
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
    truthDebugEvents,
    truthDebugConnected,
    truthDebugDisabled,
    openConfirm,
    openQuickProcessPrepare,
    failQuickProcessPrepare,
    openQuickProcess,
    confirmAndStart,
    cancel,
    closeSummary,
  };
}
