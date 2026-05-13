/**
 * File: server/queues/reservation-reaper.queue.ts
 * Purpose: reservation-reaper 队列模块。
 *          定时清理过期未消费的 credit reservation，释放占用的额度。
 *          支持两种模式：
 *          - repeatable：每 5 分钟自动触发（由 scheduler 注册）
 *          - 手动入列：测试或运维场景
 */
import { Queue } from "bullmq";
import { queueConnection } from "./connection";
import { RESERVATION_REAPER_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "reservation-reaper-queue" });

/** reservation-reaper 任务的 Job Data */
export interface ReservationReaperJobData {
  /** 触发来源（如 "scheduled"、"manual"） */
  source: string;
}

/** 单例队列实例（懒初始化） */
let _queue: Queue<ReservationReaperJobData> | null = null;

function getQueue(): Queue<ReservationReaperJobData> {
  if (!_queue) {
    _queue = new Queue<ReservationReaperJobData>(RESERVATION_REAPER_QUEUE_NAME, {
      connection: queueConnection,
    });
  }
  return _queue;
}

/**
 * 获取队列实例（供 scheduler 注册 repeatable job 使用）。
 */
export function getReservationReaperQueue(): Queue<ReservationReaperJobData> {
  return getQueue();
}

/**
 * 将 reservation 清理任务入队 BullMQ（手动触发场景）。
 * @param data 包含 source 的任务数据
 */
export async function enqueueReservationReaper(data: ReservationReaperJobData): Promise<void> {
  const queue = getQueue();

  await queue.add("reservation-reaper", data, {
    attempts: 3,
    backoff: { type: "exponential", delay: 10_000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  });

  logger.info({ source: data.source }, "reservation-reaper.enqueue");
}
