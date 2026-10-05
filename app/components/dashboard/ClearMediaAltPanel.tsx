/**
 * File: app/components/dashboard/ClearMediaAltPanel.tsx
 * Purpose: [TEMP-DEVTOOLS] Dashboard 临时面板：在页面里直接触发 scripts/clear-media-alt.ts
 *          的等价逻辑 —— 扫描并清空「当前登录店铺」全部产品图片的 alt。
 *
 *          交互: 预览(dry-run) / 待写回生产器 / 待生成生产器 → 后台任务 → 每 2s 轮询日志。
 *                前两者 = mode=clear（apply 分别 false/true）：清空 Shopify 侧 alt 后，
 *                已有草稿仍在 → 候选收敛为「待写回」；
 *                待生成生产器 = mode=pending：额外删草稿并把候选复位 INITIAL
 *                → 候选落在「待生成」（见 server/modules/devtools/pending-generation.core.server.ts）。
 *          入口: app/routes/app._index.tsx 中仅在 import.meta.env.DEV 时渲染本组件；
 *                服务端 api.dev.clear-alt.* 另有 NODE_ENV !== "production" 开关。
 *          ⚠️ 生产上线前删除本文件 + app/routes/api.dev.clear-alt.*.tsx
 *            + server/modules/devtools/ + app._index.tsx 内的 [TEMP-DEVTOOLS] 代码块。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { parseJsonResponse } from "../../lib/http-error";

/* ------------------------------------------------------------------ */
/*  类型定义（与 /api/dev/clear-alt/* 响应体对齐，客户端不导入服务端类型） */
/* ------------------------------------------------------------------ */

/** 任务状态 */
type ClearAltJobStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

/** 结果摘要（与 ClearMediaAltResult 对齐） */
interface ClearAltResult {
  shopDomain: string;
  dryRun: boolean;
  scannedPages: number;
  pendingCount: number;
  succeeded: number;
  failed: number;
  skippedOverlimit: number;
  samples: Array<{
    productId: string;
    productTitle: string;
    mediaId: string;
    currentAlt: string;
  }>;
}

/** 本地候选复位摘要（与 ResetPendingTargetsResult 对齐，仅 mode=pending 时有值） */
interface ClearAltResetSummary {
  requestCount: number;
  matchedTargets: number;
  missingTargets: number;
  resetTargets: number;
  resetCandidates: number;
  createdCandidates: number;
  deletedDrafts: number;
  skippedDecorative: number;
  skippedGenerating: number;
}

/** 任务快照（与 ClearAltJobSnapshot 对齐） */
interface ClearAltJob {
  jobId: string;
  shopDomain: string;
  /** clear = 清空 alt(待写回生产); pending = 清空 + 本地复位(待生成生产) */
  mode: "clear" | "pending";
  apply: boolean;
  status: ClearAltJobStatus;
  startedAt: string;
  finishedAt: string | null;
  /** 本次返回的日志切片 */
  logs: string[];
  /** logs[0] 在服务端缓冲中的绝对索引（用于客户端按索引去重） */
  offset: number;
  /** 服务端因缓冲上限丢弃的旧日志行数 */
  droppedLogLines: number;
  error: string | null;
  result: ClearAltResult | null;
  /** 本地候选复位摘要（仅 mode=pending 且实际执行了复位时有值） */
  reset: ClearAltResetSummary | null;
}

/* ------------------------------------------------------------------ */
/*  常量与样式                                                          */
/* ------------------------------------------------------------------ */

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 2_000;

const START_ENDPOINT = "/api/dev/clear-alt/start";
const STATUS_ENDPOINT = "/api/dev/clear-alt/status";

/** 日志控制台样式（等宽 + 深色 + 固定高度滚动） */
const LOG_BOX_STYLE: React.CSSProperties = {
  maxHeight: "16rem",
  overflowY: "auto",
  margin: 0,
  padding: "0.75rem",
  borderRadius: "0.5rem",
  background: "#1f2023",
  color: "#e5e9ef",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
  fontSize: "0.75rem",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

const STATUS_LABEL: Record<ClearAltJobStatus, string> = {
  RUNNING: "⏳ 执行中…",
  SUCCEEDED: "✅ 已结束",
  FAILED: "❌ 执行失败",
};

/* ------------------------------------------------------------------ */
/*  组件                                                                */
/* ------------------------------------------------------------------ */

interface ClearMediaAltPanelProps {
  /** 任务结束（成功或失败）后的回调，用于刷新仪表盘数据 */
  onFinished?: () => void;
}

export function ClearMediaAltPanel({ onFinished }: ClearMediaAltPanelProps) {
  /** 最近一次任务快照 */
  const [job, setJob] = useState<ClearAltJob | null>(null);
  /** 累积展示的日志 */
  const [logs, setLogs] = useState<string[]>([]);
  /** 启动请求进行中 */
  const [submitting, setSubmitting] = useState(false);
  /** 面板级错误（请求失败等） */
  const [error, setError] = useState<string | null>(null);

  /** 已拉取到的日志行数（作为增量游标传给 status 接口） */
  const seenLinesRef = useRef(0);
  /** 当前快照对应的 jobId */
  const activeJobIdRef = useRef<string | null>(null);
  /** 上一次已知的任务状态，用于识别 RUNNING → 终态的跃迁 */
  const prevStatusRef = useRef<ClearAltJobStatus | null>(null);
  /** 日志容器，用于自动滚到底部 */
  const logBoxRef = useRef<HTMLPreElement | null>(null);

  /* ---------------------------------------------------------------- */
  /*  快照落库（新任务替换 / 增量追加 / 服务端截断后整体替换）           */
  /* ---------------------------------------------------------------- */
  const applySnapshot = useCallback(
    (snapshot: ClearAltJob | null) => {
      if (!snapshot) {
        return;
      }

      setJob(snapshot);

      // 日志合并策略（按服务端绝对索引，天然对重复响应/并发轮询去重）：
      //   新任务 / 索引倒挂 / 服务端缓冲已丢行 → 整体替换
      //   其余 → 只追加本地游标之后的增量
      const isFreshJob = snapshot.jobId !== activeJobIdRef.current;
      const seen = seenLinesRef.current;
      const offset = snapshot.offset;

      if (isFreshJob || offset > seen || snapshot.droppedLogLines > 0) {
        activeJobIdRef.current = snapshot.jobId;
        seenLinesRef.current = offset + snapshot.logs.length;
        setLogs(snapshot.logs);
      } else {
        const newLines = snapshot.logs.slice(Math.max(0, seen - offset));
        if (newLines.length > 0) {
          seenLinesRef.current = seen + newLines.length;
          setLogs((prev) => prev.concat(newLines));
        }
      }

      // RUNNING → 终态：通知父组件刷新仪表盘数据
      if (prevStatusRef.current === "RUNNING" && snapshot.status !== "RUNNING") {
        onFinished?.();
      }
      prevStatusRef.current = snapshot.status;
    },
    [onFinished],
  );

  /* ---------------------------------------------------------------- */
  /*  轮询任务状态（增量拉取日志）                                      */
  /* ---------------------------------------------------------------- */
  const pollStatus = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const response = await fetch(
          `${STATUS_ENDPOINT}?after=${seenLinesRef.current}`,
          { signal },
        );
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as { job: ClearAltJob | null };
        applySnapshot(payload.job);
      } catch {
        // 轮询失败静默：不影响后台任务，下一轮自动重试
      }
    },
    [applySnapshot],
  );

  /* ---------------------------------------------------------------- */
  /*  挂载时恢复历史任务（刷新页面后仍可跟踪运行中的任务 / 查看上次结果） */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const controller = new AbortController();
    void pollStatus(controller.signal);
    return () => controller.abort();
  }, [pollStatus]);

  /* ---------------------------------------------------------------- */
  /*  运行中定时轮询                                                    */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (job?.status !== "RUNNING") {
      return;
    }

    const intervalId = window.setInterval(() => {
      void pollStatus();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [job?.status, job?.jobId, pollStatus]);

  /* ---------------------------------------------------------------- */
  /*  日志自动滚动到底部                                                */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const element = logBoxRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [logs]);

  /* ---------------------------------------------------------------- */
  /*  启动任务：mode=clear + apply=false 预览 / apply=true 待写回生产；  */
  /*  mode=pending 待生成生产（服务端强制 apply=true）                   */
  /* ---------------------------------------------------------------- */
  const startJob = useCallback(
    async (mode: "clear" | "pending", apply: boolean) => {
      setSubmitting(true);
      setError(null);

      try {
        const response = await fetch(START_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, apply }),
        });

        const payload = await parseJsonResponse<{
          error?: string;
          job?: ClearAltJob;
        }>(response);

        if (!response.ok) {
          setError(payload.error ?? `请求失败 (${response.status})`);
          // 409：已有任务在跑 → 直接跟踪该任务
          if (payload.job) {
            applySnapshot(payload.job);
          }
          return;
        }

        if (payload.job) {
          applySnapshot(payload.job);
        }
      } catch {
        setError("网络错误，请稍后重试");
      } finally {
        setSubmitting(false);
      }
    },
    [applySnapshot],
  );

  /* ---------------------------------------------------------------- */
  /*  渲染                                                             */
  /* ---------------------------------------------------------------- */
  const running = job?.status === "RUNNING" || submitting;
  const result = job?.result ?? null;

  return (
    <s-box
      padding="base"
      borderRadius="base"
      background="subdued"
      borderWidth="base"
    >
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small">
          <s-text tone="critical">🧪</s-text>
          <s-heading>临时工具：测试数据生产器（待写回 / 待生成）</s-heading>
        </s-stack>

        <s-text tone="neutral">
          等价 npx tsx scripts/clear-media-alt.ts，仅作用于当前登录店铺；dry-run
          只预览不写数据，两个生产器都会真实清空 Shopify 侧 alt（不可恢复）。
          「待写回」= 只清 alt，草稿仍在，扫描后落在待写回；「待生成」= 清 alt +
          删草稿 + 候选复位 INITIAL，扫描/统计口径下落在待生成。开发期入口，生产环境移除。
        </s-text>

        {/* 操作按钮：预览 / 待写回生产器 / 待生成生产器 */}
        <s-stack direction="inline" gap="small">
          <s-button
            variant="secondary"
            disabled={running}
            onClick={() => void startJob("clear", false)}
            accessibilityLabel="预览待清空图片 dry-run"
          >
            {running && job?.mode === "clear" && !job.apply
              ? "预览中…"
              : "预览 (dry-run)"}
          </s-button>

          <s-button
            variant="primary"
            disabled={running}
            onClick={() => void startJob("clear", true)}
            accessibilityLabel="待写回生产器：清空全部产品图片 alt"
          >
            {running && job?.mode === "clear" && job.apply ? "清空中…" : "待写回生产器"}
          </s-button>

          <s-button
            variant="primary"
            tone="critical"
            disabled={running}
            onClick={() => void startJob("pending", true)}
            accessibilityLabel="待生成生产器：清空 alt 并把候选复位为待生成"
          >
            {running && job?.mode === "pending" ? "造数中…" : "待生成生产器"}
          </s-button>
        </s-stack>

        {/* 面板级错误 */}
        {error && (
          <s-box padding="small" borderRadius="base" background="strong">
            <s-text tone="critical">{error}</s-text>
          </s-box>
        )}

        {/* 任务状态与结果摘要 */}
        {job && (
          <s-stack direction="block" gap="small">
            <s-stack direction="inline" gap="base">
              <s-text>
                {STATUS_LABEL[job.status]}（
                {job.mode === "pending"
                  ? "待生成生产"
                  : job.apply
                    ? "待写回生产"
                    : "dry-run"}
                ）
              </s-text>
              {result && (
                <s-text tone="neutral">
                  待清空 {result.pendingCount} 张
                  {result.dryRun ? "" : ` · 成功 ${result.succeeded} · 失败 ${result.failed}`}
                  {result.skippedOverlimit > 0
                    ? ` · 媒体超限跳过 ${result.skippedOverlimit} 个产品`
                    : ""}
                </s-text>
              )}
              {job.error && <s-text tone="critical">{job.error}</s-text>}
            </s-stack>

            {/* 待生成生产器专属：本地候选复位摘要 */}
            {job.reset && (
              <s-text tone="neutral">
                本地复位候选 {job.reset.resetCandidates} 张（补建 {job.reset.createdCandidates}
                {" · "}删草稿 {job.reset.deletedDrafts}）
                {" · "}跳过 装饰性 {job.reset.skippedDecorative} / 生成中{" "}
                {job.reset.skippedGenerating}
                {job.reset.missingTargets > 0
                  ? ` · 本地无 target ${job.reset.missingTargets} 张`
                  : ""}
              </s-text>
            )}
          </s-stack>
        )}

        {/* 执行日志（等价 CLI 的终端输出） */}
        {logs.length > 0 && (
          <pre ref={logBoxRef} style={LOG_BOX_STYLE}>
            {logs.join("\n")}
          </pre>
        )}
      </s-stack>
    </s-box>
  );
}


