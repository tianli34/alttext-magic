// worker/utils/scan-run-logger.ts
/**
 * 扫描链路专用日志：将一次「用户手动触发的扫描」全过程（scan-start → parse-bulk →
 * derive-scan → publish-scan → generate-alt → writeback）的结构化日志聚合写入
 * logs/worker.log。
 *
 * 设计约束：
 * - 仅以下 6 个扫描队列的任务会写入 worker.log；其余（5 个 repeatable 调度器、
 *   3 个 setInterval 扫描、webhook、continuous-scan、reaper、cleanup、gdpr 等
 *   自动任务）一律不写入，避免污染。
 * - 每次新扫描开始时先清空上一次的任务日志（startScanRunLog 内 truncate）。
 * - worker.log 不再由全局 logger 落盘（见 worker/bootstrap.ts），仅由此模块管理。
 */
import path from "node:path";
import fs from "node:fs";
import pino, { type LogDescriptor } from "pino";
import {
  SCAN_START_QUEUE_NAME,
  PARSE_BULK_QUEUE_NAME,
  DERIVE_SCAN_QUEUE_NAME,
  PUBLISH_SCAN_QUEUE_NAME,
  GENERATE_ALT_QUEUE_NAME,
  WRITEBACK_QUEUE_NAME,
} from "../../server/config/queue-names.js";

/** worker.log 落盘路径（项目根 logs/ 目录） */
export const WORKER_LOG_PATH = path.resolve(process.cwd(), "logs", "worker.log");

/** 属于「手动扫描链路」的队列集合 */
export const SCAN_PIPELINE_QUEUES = new Set<string>([
  SCAN_START_QUEUE_NAME,
  PARSE_BULK_QUEUE_NAME,
  DERIVE_SCAN_QUEUE_NAME,
  PUBLISH_SCAN_QUEUE_NAME,
  GENERATE_ALT_QUEUE_NAME,
  WRITEBACK_QUEUE_NAME,
]);

/** 扫描链路入口队列（触发清空上一次日志） */
export const SCAN_START_QUEUE = SCAN_START_QUEUE_NAME;

/** 判断某队列是否属于手动扫描链路 */
export function isScanPipelineQueue(queueName: string | undefined): boolean {
  return queueName ? SCAN_PIPELINE_QUEUES.has(queueName) : false;
}

// 专用文件 logger：仅扫描链路写入。append 默认 true，配合 startScanRunLog 的
// truncate 在每次新扫描前清空；pino 的 destination 会序列化并发写入，避免互相覆盖。
const scanFileDestination = pino.destination({
  dest: WORKER_LOG_PATH,
  mkdir: true,
});

const scanFileLogger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    base: {
      app: "shopify-app",
      env: process.env.NODE_ENV || "development",
      log_target: "scan-run",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  scanFileDestination,
);

/**
 * 清空上一次任务日志，并开始记录一次新的手动扫描链路。
 * 仅在扫描入口（scan-start）调用，保证「记录前清空上一次」。
 *
 * @param scanJobId 扫描任务 ID
 * @param shopId 店铺 ID（可选）
 */
export function startScanRunLog(scanJobId?: string, shopId?: string): void {
  try {
    fs.truncateSync(WORKER_LOG_PATH, 0);
  } catch {
    // 文件尚不存在时 truncate 会抛错；mkdir 已确保目录存在，忽略即可
  }
  scanFileLogger.info({ scanJobId, shopId }, "scan-run.start");
}

/**
 * 向扫描链路日志文件追加一条结构化日志。
 * 注意：stdout 的标准输出由调用方原有的 logger 负责，本函数只负责文件落盘。
 *
 * @param msg 日志消息
 * @param obj 结构化上下文（可选）
 */
export function writeScanLog(msg: string, obj?: LogDescriptor): void {
  scanFileLogger.info(obj ?? {}, msg);
}
