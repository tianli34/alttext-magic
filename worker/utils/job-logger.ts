// worker/utils/job-logger.ts
import { type Job } from "bullmq";
import { createLogger, type LogContext } from "../../shared/logger/index.js";

/**
 * 为 BullMQ (消息队列库) 的 Job (任务) 提供结构化日志装饰器，自动度量任务开始、结束、异常与耗时
 *
 * @param job - BullMQ 任务对象实例
 * @param handler - 实际任务处理器函数
 */
export async function withJobLogger<T, R>(
  job: Job<T>,
  handler: (job: Job<T>) => Promise<R>
): Promise<R> {
  const startTime = Date.now();
  const data = job.data as any;

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

  jobLogger.info("job.start");

  try {
    const result = await handler(job);
    const duration_ms = Date.now() - startTime;
    jobLogger.info({ duration_ms }, "job.finish");
    return result;
  } catch (error: any) {
    const duration_ms = Date.now() - startTime;
    jobLogger.error(
      {
        duration_ms,
        error_code: error.code || error.name || "UNKNOWN_ERROR",
        error_message: error.message || String(error),
        err: error,
      },
      "job.error"
    );
    // 必须原样抛出，保证 BullMQ 原生的重试机制正常运行
    throw error;
  }
}
