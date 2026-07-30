/**
 * 扫描进度条 worker 日志提取脚本。
 *
 * 目标：给定一个 scanJobId，导出「最后一个结束（finished_at 最晚）的资源进度条」
 * 从开始到结束的全部 worker 日志。
 *
 * 前置条件：
 *   worker 进程运行时须已开启日志文件落盘（见 worker/bootstrap.ts 默认写入 logs/worker.log；
 *   或通过 LOG_FILE 环境变量自定义路径）。若目标扫描发生在开启落盘之前，其日志无法追溯。
 *
 * 用法：
 *   npx tsx scripts/scan-worker-logs.ts <scanJobId> [--file <logPath>] [--resource <TYPE>]
 *
 * 参数：
 *   <scanJobId>          必填，扫描任务 ID。
 *   --file <logPath>     可选，worker JSON 日志文件路径；缺省依次尝试
 *                        环境变量 LOG_FILE 与 logs/worker.log。
 *   --resource <TYPE>    可选，手动指定资源类型（PRODUCT_MEDIA/FILES/COLLECTION_IMAGE/ARTICLE_IMAGE），
 *                        覆盖「finished_at 最晚」的默认选定逻辑。
 *
 * 相关字段口径（与 worker 日志绑定一致，见 worker/utils/scan-run-logger.ts）：
 *   - worker.log 现已仅由 scan-run-logger 管理：每次新扫描（scan-start）开始前 truncate，
 *     故文件内只保留「最近一次 scanJobId」的扫描链路日志；全局 logger 不再落盘于此。
 *   - 每条记录带 base 字段：level（pino 数字：30=info/50=error…）、time（ISO 字符串）、
 *     app、env、log_target="scan-run"。
 *   - 进度条级（parse-bulk / derive-scan）：BullMQ job.id == scanTaskAttemptId
 *     （enqueueParseBulkToStaging / enqueueDeriveScan 均以 scanTaskAttemptId 作 jobId），
 *     经 withJobLogger 绑定为 job_item_id，并在 worker.completed/failed 中显式带出
 *     scanTaskAttemptId / jobId；故可用 attemptIds 直接命中。
 *   - 运行级（scan-start / publish-scan / scan-run.start）：仅带 scanJobId，无 resourceType，
 *     无法在日志内区分资源，故以 scanJobId 整体命中。
 *   - 旧格式的 scanTaskId / resourceType 字段已不再写入，相关分支仅作向后兼容保留。
 */
import "dotenv/config";
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import pino from "pino";

const logger = pino({ name: "scan-worker-logs" });

const RESOURCE_TYPES = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];

type ScanTaskRow = {
  id: string;
  resource_type: string;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
};

type AttemptRow = {
  id: string;
  attempt_no: number;
  status: string;
  bulk_operation_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
};

/**
 * 解析命令行参数
 */
function parseArgs(argv: string[]): {
  scanJobId?: string;
  file?: string;
  resource?: string;
} {
  const out: { scanJobId?: string; file?: string; resource?: string } = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      out.file = argv[++i];
    } else if (a === "--resource") {
      out.resource = argv[++i];
    } else {
      rest.push(a);
    }
  }
  out.scanJobId = rest[0];
  return out;
}

/**
 * 定位 worker 日志文件：优先 --file，其次 LOG_FILE，最后 logs/worker.log
 */
function resolveLogFile(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.LOG_FILE,
    path.resolve(process.cwd(), "logs", "worker.log"),
  ].filter((p): p is string => Boolean(p));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function fmt(d: Date | null): string {
  return d ? d.toISOString().replace("T", " ").slice(0, 19) : "-";
}

/**
 * 从 DB 选定目标进度条并收集其全部 attempt 标识
 */
async function resolveTarget(
  scanJobId: string,
  forceResource?: string,
): Promise<{
  task: ScanTaskRow;
  attempts: AttemptRow[];
  attemptIds: Set<string>;
}> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const taskRes = await client.query<ScanTaskRow>(
      `SELECT id, resource_type, status, started_at, finished_at, error
         FROM scan_task
        WHERE scan_job_id = $1`,
      [scanJobId],
    );

    if (taskRes.rowCount === 0) {
      console.log("[DEBUG] scan_task 查询结果为空");
      logger.error({ scanJobId }, "未找到该 scanJobId 对应的 scan_task 记录");
      process.exit(2);
    }

    let task: ScanTaskRow | undefined;
    if (forceResource) {
      task = taskRes.rows.find((r) => r.resource_type === forceResource);
      if (!task) {
        logger.error(
          { scanJobId, forceResource },
          "指定的 resourceType 在该扫描中不存在",
        );
        process.exit(2);
      }
    } else {
      // finished_at 最晚者；未完成(NULL)视为最靠后，便于排查卡死的进度条
      task = [...taskRes.rows].sort((a, b) => {
        const at = a.finished_at ? a.finished_at.getTime() : Number.MAX_SAFE_INTEGER;
        const bt = b.finished_at ? b.finished_at.getTime() : Number.MAX_SAFE_INTEGER;
        return bt - at;
      })[0];
    }

    const attemptRes = await client.query<AttemptRow>(
      `SELECT id, attempt_no, status, bulk_operation_id, started_at, finished_at
         FROM scan_task_attempt
        WHERE scan_task_id = $1
        ORDER BY attempt_no`,
      [task.id],
    );

    const attemptIds = new Set<string>(attemptRes.rows.map((r) => r.id));

    // DEBUG: 步骤 2 开头和结尾 — 目标 task 的原始时间
    if (task) {
      const a0 = attemptRes.rows[0];
      console.log(
        `[DEBUG] step2  resourceType=${task.resource_type}  task.startedAt_iso=${task.started_at?.toISOString()}  attempt.startedAt_iso=${a0?.started_at?.toISOString()}  tzOffset=${new Date().getTimezoneOffset()}`,
      );
    }

    return { task, attempts: attemptRes.rows, attemptIds };
  } finally {
    await client.end();
  }
}

/**
 * 判断一条日志是否属于目标扫描运行 / 目标进度条。
 *
 * 命中逻辑（见文件头「相关字段口径」）：
 *   1) 进度条级：记录中任一 attempt 标识（job_item_id / jobId / scanTaskAttemptId /
 *      scanTaskId）命中 attemptIds 集合（对应 scan_task_attempt.id）。
 *   2) 运行级：scan-start / publish-scan / scan-run.start 仅带 scanJobId，
 *      以 scanJobId 整体命中（这些记录无法在日志内区分资源，故整链纳入）。
 *   3) 兜底（旧格式）：resourceType + scanJobId 同时命中，向后兼容。
 */
function matchesTarget(
  entry: Record<string, unknown>,
  scanJobId: string,
  scanTaskId: string,
  attemptIds: Set<string>,
  resourceType: string,
): boolean {
  // 1) 进度条级：命中某个 scan_task_attempt 的标识
  const attemptKeys = ["job_item_id", "jobId", "scanTaskAttemptId", "scanTaskId"];
  for (const k of attemptKeys) {
    const v = entry[k];
    if (typeof v === "string" && attemptIds.has(v)) return true;
  }
  // 2) 运行级：仅绑定 scanJobId 的派发/发布记录（scan-start / publish-scan / scan-run.start）
  if (typeof entry.scanJobId === "string" && entry.scanJobId === scanJobId) {
    return true;
  }
  // 3) 兜底（旧格式）：resourceType 绑定，新格式已不带，保留兼容
  if (entry.resourceType === resourceType && entry.scanJobId === scanJobId) {
    return true;
  }
  return false;
}

/** pino 数字 level → 名称（worker.log 现以数字落盘） */
const PINO_LEVELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

function levelName(lv: unknown): string {
  if (typeof lv === "number") return PINO_LEVELS[lv] ?? String(lv);
  return typeof lv === "string" ? lv : String(lv ?? "");
}

/** 日志内模块缺省时，回退展示 queue / job_name，便于定位来源 */
function moduleOf(entry: Record<string, unknown>): string {
  const m = entry.module ?? entry.queue ?? entry.job_name;
  return typeof m === "string" ? m : "";
}

async function run(): Promise<void> {
  const { scanJobId, file, resource } = parseArgs(process.argv.slice(2));

  if (!scanJobId) {
    logger.error(
      {
        usage:
          "npx tsx scripts/scan-worker-logs.ts <scanJobId> [--file <logPath>] [--resource <TYPE>]",
      },
      "缺少 scanJobId 参数",
    );
    process.exit(1);
  }

  if (resource && !RESOURCE_TYPES.includes(resource as ResourceType)) {
    logger.error(
      { resource, valid: RESOURCE_TYPES },
      "--resource 取值非法",
    );
    process.exit(1);
  }

  const { task, attempts, attemptIds } = await resolveTarget(scanJobId, resource);

  // 头部：目标进度条摘要
  console.log("");
  console.log(
    `目标进度条: ${task.resource_type}  (scanTaskId=${task.id})`,
  );
  console.log(
    `  状态=${task.status}  开始=${fmt(task.started_at)}  结束=${fmt(task.finished_at)}${
      task.error ? `  错误=${task.error}` : ""
    }`,
  );
  console.log(`  attempt 数=${attempts.length}:`);
  for (const a of attempts) {
    console.log(
      `    - #${a.attempt_no} id=${a.id} status=${a.status} bulkOp=${
        a.bulk_operation_id ?? "-"
      } ${fmt(a.started_at)} → ${fmt(a.finished_at)}`,
    );
  }
  console.log("-".repeat(96));

  const logPath = resolveLogFile(file);
  if (!logPath) {
    console.log("");
    console.log(
      "⚠️ 未找到 worker 日志文件（已尝试 --file / LOG_FILE / logs/worker.log）。",
    );
    console.log(
      "   若该扫描发生在开启日志落盘之前，则其逐行 worker 日志无法追溯，仅能得到上述 DB 摘要。",
    );
    process.exit(0);
  }

  logger.info({ logPath, scanTaskId: task.id }, "开始逐行扫描 worker 日志");

  // 逐行解析 JSON 日志，命中目标进度条则收集
  const matched: Array<{ time: number; raw: string; entry: Record<string, unknown> }> =
    [];
  let total = 0;
  let unparsable = 0;
  // worker.log 每次新扫描开始会 truncate，故文件内仅保留最近一次 scanJobId 的链路。
  // 记录文件中出现的 scan-run.start 对应的 scanJobId，用于覆盖检测。
  let lastRunScanJobId: string | null = null;

  const rl = createInterface({
    input: createReadStream(logPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    total++;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      unparsable++;
      continue;
    }
    // 记录扫描运行起点（scan-run.start）所归属的 scanJobId
    if (entry.msg === "scan-run.start" && typeof entry.scanJobId === "string") {
      lastRunScanJobId = entry.scanJobId;
    }
    if (
      matchesTarget(entry, scanJobId, task.id, attemptIds, task.resource_type)
    ) {
      const t =
        typeof entry.time === "number"
          ? entry.time
          : typeof entry.time === "string"
            ? Date.parse(entry.time)
            : Number.NaN;
      matched.push({ time: Number.isNaN(t) ? 0 : t, raw: trimmed, entry });
    }
  }

  // 按时间升序输出（覆盖 scan-start 派发 → parse-bulk → derive-scan → publish-scan 全链路）
  matched.sort((a, b) => a.time - b.time);

  // 覆盖检测：worker.log 仅保留最近一次扫描，若与请求不一致则说明已被新扫描覆盖
  if (lastRunScanJobId && lastRunScanJobId !== scanJobId) {
    console.log("");
    console.log(
      `⚠️ worker.log 当前仅保留最近一次扫描的链路日志，其 scanJobId=${lastRunScanJobId} 与请求的 ${scanJobId} 不一致。`,
    );
    console.log(
      "   该扫描的 worker 日志已被后续扫描的「每次 scan-start 清空」覆盖，无法从文件中追溯。",
    );
  }

  console.log("");
  console.log(
    `匹配到 ${matched.length} 条日志（共扫描 ${total} 行，无法解析 ${unparsable} 行）：`,
  );
  console.log("=".repeat(96));
  for (const m of matched) {
    const ts =
      typeof m.entry.time === "number"
        ? new Date(m.entry.time).toISOString().replace("T", " ").slice(0, 23)
        : String(m.entry.time ?? "");
    const level = levelName(m.entry.level);
    const mod = moduleOf(m.entry);
    const msg = m.entry.msg ?? "";
    console.log(`[${ts}] (${level}) ${mod} :: ${msg}`);
    console.log(m.raw);
    console.log("-".repeat(96));
  }

  if (matched.length === 0) {
    console.log(
      "⚠️ 日志文件中未匹配到该进度条的任何行。可能原因：该扫描早于落盘开启、已被后续扫描覆盖（见上方覆盖提示），或日志已按 count 被 BullMQ/轮转清理。",
    );
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "脚本执行失败");
    process.exit(1);
  });
