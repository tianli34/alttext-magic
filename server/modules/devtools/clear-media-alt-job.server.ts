/**
 * File: server/modules/devtools/clear-media-alt-job.server.ts
 * Purpose: [TEMP-DEVTOOLS] 把 runClearMediaAlt 包装成「进程内后台任务」，供 Dashboard
 *          临时按钮调用。
 *
 *          为什么不在请求里直接 await 执行：清空全店图片 alt 需要分页扫描 + 分批
 *          fileUpdate（批次间还刻意留 500ms 避让限流），耗时远超 tunnel/网关的空闲超时，
 *          同步等待会让 HTTP 请求被掐断而任务仍在跑，状态不可见。因此改为：
 *            POST 启动 → 立即返回 jobId → 前端轮询 status 拉增量日志。
 *
 *          状态存内存（挂 global 防 HMR 丢失），每店铺仅保留最近一次任务，
 *          同一店铺 RUNNING 期间互斥。服务重启即丢失历史任务（临时工具可接受）。
 *
 *          ⚠️ 临时性质，生产上线前与 clear-media-alt.core.server.ts 一并删除。
 */
import { randomUUID } from "node:crypto";
import { createLogger } from "../../utils/logger";
import {
  runClearMediaAlt,
  type ClearMediaAltLog,
  type ClearMediaAltResult,
  type ClearMediaAltTokenResolver,
} from "./clear-media-alt.core.server";

const logger = createLogger({ module: "devtools-clear-alt-job" });

/** 单任务日志缓冲上限（超出后丢弃最早的行，并累计丢弃数） */
const MAX_LOG_LINES = 600;

/** 任务状态 */
export type ClearAltJobStatus = "RUNNING" | "SUCCEEDED" | "FAILED";

/** 进程内任务记录 */
interface ClearAltJob {
  jobId: string;
  shopDomain: string;
  /** false = dry-run 预览, true = 实际清空 */
  apply: boolean;
  status: ClearAltJobStatus;
  startedAt: Date;
  finishedAt: Date | null;
  /** 日志缓冲（最多 MAX_LOG_LINES 行） */
  logs: string[];
  /** 因超出缓冲上限而被丢弃的行数 */
  droppedLogLines: number;
  /** 失败原因（status = FAILED 时有值） */
  error: string | null;
  /** 执行结果摘要（status = SUCCEEDED 时有值） */
  result: ClearMediaAltResult | null;
}

/** 对外暴露的任务快照（API 响应体） */
export interface ClearAltJobSnapshot {
  jobId: string;
  shopDomain: string;
  apply: boolean;
  status: ClearAltJobStatus;
  startedAt: string;
  finishedAt: string | null;
  /** 本次返回的日志切片 */
  logs: string[];
  /** logs[0] 在完整日志缓冲中的绝对索引（= droppedLogLines + 切片起点），供前端增量续传/去重 */
  offset: number;
  /** 因超出缓冲上限而被丢弃的行数 */
  droppedLogLines: number;
  /** 失败原因（status = FAILED 时有值） */
  error: string | null;
  /** 执行结果摘要（status = SUCCEEDED 时有值） */
  result: ClearMediaAltResult | null;
}

// ── 进程内任务表（挂 global 防开发环境 HMR 重置） ──────────────────────
const globalForClearAltJobs = global as unknown as {
  __alttextClearAltJobs: Map<string, ClearAltJob> | undefined;
};

const jobs: Map<string, ClearAltJob> =
  globalForClearAltJobs.__alttextClearAltJobs ?? new Map<string, ClearAltJob>();

globalForClearAltJobs.__alttextClearAltJobs = jobs;

// ── 开关 ──────────────────────────────────────────────────────────────
/**
 * 临时工具总开关：生产环境默认关闭（返回 404），
 * 本地需要联调生产构建时可显式 ENABLE_DEV_TOOLS=1 强制打开。
 */
export function isDevToolsEnabled(): boolean {
  if (process.env.ENABLE_DEV_TOOLS === "1") {
    return true;
  }
  return process.env.NODE_ENV !== "production";
}

// ── 内部工具 ──────────────────────────────────────────────────────────
/** 追加日志行（支持一次回调内含多行），并维持缓冲上限 */
function appendLog(job: ClearAltJob, raw: string): void {
  for (const line of raw.split("\n")) {
    job.logs.push(line);
  }
  if (job.logs.length > MAX_LOG_LINES) {
    const overflow = job.logs.length - MAX_LOG_LINES;
    job.logs.splice(0, overflow);
    job.droppedLogLines += overflow;
  }
}

/**
 * 生成对外快照。
 * @param after 增量游标：只返回绝对索引 >= after 的日志行（绝对索引 = droppedLogLines + 数组下标）
 */
function toSnapshot(job: ClearAltJob, after?: number): ClearAltJobSnapshot {
  const dropped = job.droppedLogLines;
  const start =
    typeof after === "number" && Number.isInteger(after) && after > dropped
      ? Math.min(after - dropped, job.logs.length)
      : 0;

  return {
    jobId: job.jobId,
    shopDomain: job.shopDomain,
    apply: job.apply,
    status: job.status,
    startedAt: job.startedAt.toISOString(),
    finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    logs: job.logs.slice(start),
    offset: dropped + start,
    droppedLogLines: dropped,
    error: job.error,
    result: job.result,
  };
}

// ── 对外 API ──────────────────────────────────────────────────────────
export interface StartClearAltJobParams {
  shopDomain: string;
  apply: boolean;
  /** 可选：自定义 token 获取（Dashboard 入口注入官方 offline admin 链路） */
  resolveAccessToken?: ClearMediaAltTokenResolver;
}

/**
 * 启动一次清空任务（不等待执行完成）。
 * 返回 started=false 表示该店铺已有任务在跑（互斥），快照为当前运行中的任务。
 */
export function startClearAltJob(
  params: StartClearAltJobParams,
): { started: boolean; job: ClearAltJobSnapshot } {
  const existing = jobs.get(params.shopDomain);
  if (existing?.status === "RUNNING") {
    return { started: false, job: toSnapshot(existing) };
  }

  const job: ClearAltJob = {
    jobId: randomUUID(),
    shopDomain: params.shopDomain,
    apply: params.apply,
    status: "RUNNING",
    startedAt: new Date(),
    finishedAt: null,
    logs: [],
    droppedLogLines: 0,
    error: null,
    result: null,
  };
  jobs.set(params.shopDomain, job);

  const log: ClearMediaAltLog = (line) => appendLog(job, line);

  logger.info(
    {
      jobId: job.jobId,
      shopDomain: job.shopDomain,
      apply: job.apply,
    },
    "[TEMP-DEVTOOLS] clear-media-alt job started",
  );

  // 后台执行：不 await，状态与日志由轮询接口读取
  void runClearMediaAlt({
    shopDomain: params.shopDomain,
    apply: params.apply,
    log,
    ...(params.resolveAccessToken
      ? { resolveAccessToken: params.resolveAccessToken }
      : {}),
  })
    .then((result) => {
      job.result = result;
      job.status = "SUCCEEDED";
      job.finishedAt = new Date();
      logger.info(
        {
          jobId: job.jobId,
          shopDomain: job.shopDomain,
          pendingCount: result.pendingCount,
          succeeded: result.succeeded,
          failed: result.failed,
          dryRun: result.dryRun,
        },
        "[TEMP-DEVTOOLS] clear-media-alt job finished",
      );
    })
    .catch((err: unknown) => {
      job.status = "FAILED";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date();
      logger.error(
        { jobId: job.jobId, shopDomain: job.shopDomain, err },
        "[TEMP-DEVTOOLS] clear-media-alt job failed",
      );
    });

  return { started: true, job: toSnapshot(job) };
}

/**
 * 读取某店铺最近一次任务快照，无则 null。
 * @param after 增量日志游标（见 toSnapshot），省略则返回缓冲内全部日志
 */
export function getClearAltJob(
  shopDomain: string,
  after?: number,
): ClearAltJobSnapshot | null {
  const job = jobs.get(shopDomain);
  if (!job) {
    return null;
  }
  return typeof after === "number" ? toSnapshot(job, after) : toSnapshot(job);
}
