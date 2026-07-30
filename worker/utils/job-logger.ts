// worker/utils/job-logger.ts
import { type Job } from "bullmq";
import { createLogger, type LogContext } from "../../shared/logger/index.js";
import {
  isScanPipelineQueue,
  SCAN_START_QUEUE,
  startScanRunLog,
  writeScanLog,
} from "./scan-run-logger.js";

/**
 * 为 BullMQ (消息队列库) 的 Job (任务) 提供结构化日志装饰器，自动度量任务开始、结束、异常与耗时
 *
 * @param job - BullMQ 任务对象实例
 * @param handler - 实际任务处理器函数
 */
export async function withJobLogger<T, R>(
  job: Job<T>,
  handler: (job: Job<T>) => Promise<R>,
  queueName?: string
): Promise<R> {
  const startTime = Date.now();
  // 仅声明日志所需的可选字段，避免 any
  const data = job.data as unknown as {
    shopDomain?: string;
    shop?: string;
    batchId?: string;
    altPlane?: string;
    shopifyImageId?: string;
    imageId?: string;
    scanJobId?: string;
    shopId?: string;
  };

  // 1. 自动提取潜在的字段以构建结构化日志上下文
  const shopDomain = data?.shopDomain || data?.shop || undefined;
  const batchId = data?.batchId || undefined;
  const altPlane = data?.altPlane || undefined;
  const writeTargetId = data?.shopifyImageId || data?.imageId || undefined;

  const ctx: LogContext = {
    shop_domain: shopDomain,
    batch_id: batchId,
    alt_plane: altPlane,
    write_target_id: writeTargetId,
    job_item_id: job.id || undefined,
  };

  // 2. 创建附带上下文的 Job 子 Logger (日志记录器)
  const jobLogger = createLogger("job-runtime").withContext(ctx).child({
    job_name: job.name,
    attempt: job.attemptsMade + 1,
  });

  // 是否属于手动扫描链路（仅这些任务写入 worker.log）
  const isScan = isScanPipelineQueue(queueName);
  // 扫描入口（scan-start）：清空上一次任务日志，开启本次记录
  if (isScan && queueName === SCAN_START_QUEUE) {
    startScanRunLog(data?.scanJobId, data?.shopId);
  }

  jobLogger.info("job.start");
  if (isScan) {
    writeScanLog("job.start", { ...ctx, job_name: job.name, attempt: job.attemptsMade + 1 });
  }

  try {
    const result = await handler(job);
    const duration_ms = Date.now() - startTime;
    jobLogger.info({ duration_ms }, "job.finish");
    if (isScan) {
      writeScanLog("job.finish", {
        ...ctx,
        job_name: job.name,
        attempt: job.attemptsMade + 1,
        duration_ms,
      });
    }
    return result;
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const err = error instanceof Error ? error : new Error(String(error));
    const errorCode = (err as { code?: string }).code ?? err.name ?? "UNKNOWN_ERROR";
    const errorMessage = err.message ?? String(error);
    jobLogger.error(
      {
        duration_ms,
        error_code: errorCode,
        error_message: errorMessage,
        err: error,
      },
      "job.error"
    );
    if (isScan) {
      writeScanLog("job.error", {
        ...ctx,
        job_name: job.name,
        attempt: job.attemptsMade + 1,
        duration_ms,
        error_code: errorCode,
        error_message: errorMessage,
        err: error,
      });
    }
    // 必须原样抛出，保证 BullMQ 原生的重试机制正常运行
    throw error;
  }
}
