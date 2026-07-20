/**
 * 扫描进度排查脚本（方案 A）。
 *
 * 当「倒数第 2 个进度条完成 5 秒后最后 1 个仍未跑完」的异常出现时，
 * 直接从 Postgres 的 scan_task 表读取每类资源的权威终态，
 * 找出非 SUCCESS 的进度条，无需翻阅海量终端日志。
 *
 * 用法：
 *   npx tsx scripts/scan-progress-inspect.ts <scanJobId>
 *
 * 判定口径：
 *   scan_task.status 为 SUCCESS 表示该类进度条已跑完；
 *   其余状态（PENDING / RUNNING / FAILED）即未跑完 / 异常，
 *   其中 FAILED 额外展示 error，RUNNING/PENDING 提示仍在处理或未开始。
 */
import "dotenv/config";
import { Client } from "pg";
import pino from "pino";

const logger = pino({ name: "scan-progress-inspect" });

// 4 类资源固定顺序（与前端进度条、扫描调度顺序一致）
const RESOURCE_TYPES = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
] as const;

type ScanTaskRow = {
  resource_type: string;
  status: string;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
};

type ScanJobRow = {
  status: string;
  successful_resource_types: unknown;
  failed_resource_types: unknown;
};

function statusIcon(status: string): string {
  return status === "SUCCESS" ? "✅" : "⚠️";
}

async function inspect(scanJobId: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // 1. 读取 scan_job 级成功/失败资源清单，做交叉验证
    const jobRes = await client.query<ScanJobRow>(
      `SELECT status,
              successful_resource_types,
              failed_resource_types
         FROM scan_job
        WHERE id = $1`,
      [scanJobId],
    );

    if (jobRes.rowCount === 0) {
      logger.error({ scanJobId }, "未找到对应的 scan_job 记录");
      process.exit(2);
    }

    const job = jobRes.rows[0];
    const successful = Array.isArray(job.successful_resource_types)
      ? (job.successful_resource_types as string[])
      : [];
    const failed = Array.isArray(job.failed_resource_types)
      ? (job.failed_resource_types as string[])
      : [];

    // 2. 读取 4 类资源的 scan_task 终态
    const taskRes = await client.query<ScanTaskRow>(
      `SELECT resource_type,
              status,
              started_at,
              finished_at,
              error
         FROM scan_task
        WHERE scan_job_id = $1
        ORDER BY resource_type`,
      [scanJobId],
    );

    const taskByType = new Map<string, ScanTaskRow>();
    for (const row of taskRes.rows) {
      taskByType.set(row.resource_type, row);
    }

    // 3. 逐类展示
    logger.info({ scanJobId, scanJobStatus: job.status }, "扫描进度排查结果");
    console.log("");
    console.log(
      `${"资源类型".padEnd(18)}${"状态".padEnd(12)}${"开始时间".padEnd(24)}${"结束时间".padEnd(24)}备注`,
    );
    console.log("-".repeat(96));

    const abnormal: string[] = [];

    for (const rt of RESOURCE_TYPES) {
      const row = taskByType.get(rt);
      if (!row) {
        abnormal.push(rt);
        console.log(
          `${"❓ " + rt.padEnd(17)}${"缺失".padEnd(12)}${"-".padEnd(22)}${"-".padEnd(22)}scan_task 无该资源记录`,
        );
        continue;
      }

      const ok = row.status === "SUCCESS";
      if (!ok) abnormal.push(rt);

      const started = row.started_at
        ? row.started_at.toISOString().replace("T", " ").slice(0, 19)
        : "-";
      const finished = row.finished_at
        ? row.finished_at.toISOString().replace("T", " ").slice(0, 19)
        : "-";
      const remark =
        row.status === "FAILED"
          ? `失败: ${row.error ?? "无错误信息"}`
          : row.status === "RUNNING"
            ? "仍在处理中"
            : row.status === "PENDING"
              ? "尚未开始"
              : "";

      console.log(
        `${statusIcon(row.status)} ${rt.padEnd(17)}${row.status.padEnd(12)}${started.padEnd(22)}${finished.padEnd(22)}${remark}`,
      );
    }

    console.log("-".repeat(96));

    // 4. 交叉验证：scan_job 的清单与 scan_task 是否一致
    const taskSuccess = RESOURCE_TYPES.filter(
      (rt) => taskByType.get(rt)?.status === "SUCCESS",
    );
    const inconsistent =
      successful.length > 0 &&
      new Set([...successful].sort()).toString() !==
        new Set([...taskSuccess].sort()).toString();

    // 5. 汇总异常进度条
    console.log("");
    if (abnormal.length === 0) {
      console.log("✅ 4 类资源进度条全部 SUCCESS，无异常。");
    } else {
      console.log(`⚠️ 存在 ${abnormal.length} 条非 SUCCESS 进度条（异常）:`);
      for (const rt of abnormal) {
        const row = taskByType.get(rt);
        const hint =
          row?.status === "FAILED"
            ? "→ 查看该资源 scan_task_attempt 的 last_parse_error / 业务日志"
            : row?.status === "RUNNING"
              ? "→ 查看对应 worker 进程 / BullMQ 队列是否堆积或卡死"
              : row?.status === "PENDING"
                ? "→ 查看扫描调度器是否未派发该资源任务"
                : "→ scan_task 记录缺失，检查任务派发逻辑";
        console.log(`   - ${rt} (status=${row?.status ?? "缺失"})${hint}`);
      }
    }

    if (inconsistent) {
      console.log("");
      console.log(
        `⚠️ 交叉校验不一致: scan_job.successfulResourceTypes=${JSON.stringify(successful)}，但 scan_task 中 SUCCESS 类=${JSON.stringify(taskSuccess)}`,
      );
    }

    if (successful.length > 0 || failed.length > 0) {
      console.log("");
      console.log(`scan_job 清单 → 成功类: ${JSON.stringify(successful)}；失败类: ${JSON.stringify(failed)}`);
    }
  } finally {
    await client.end();
  }
}

const scanJobId = process.argv[2];
if (!scanJobId) {
  logger.error({ usage: "npx tsx scripts/scan-progress-inspect.ts <scanJobId>" }, "缺少 scanJobId 参数");
  process.exit(1);
}

inspect(scanJobId)
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, "脚本执行失败");
    process.exit(1);
  });
