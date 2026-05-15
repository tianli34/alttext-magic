/**
 * File: server/queues/generate-alt.queue.ts
 * Purpose: generate_alt 队列生产者，按单条候选图片投递 AI 生成任务。
 */
import { AltPlane } from "@prisma/client";
import { Queue } from "bullmq";
import { GENERATE_ALT_QUEUE_NAME } from "../config/queue-names";
import { createLogger } from "../utils/logger";
import { queueConnection } from "./connection";

const logger = createLogger({ module: "generate-alt-queue" });

export interface GenerateAltJobData {
  batchId: string;
  candidateId: string;
  shopId: string;
  shopifyImageId: string;
  altPlane: AltPlane;
  imageUrl: string;
}

let queue: Queue<GenerateAltJobData> | null = null;

export function getGenerateAltQueue(): Queue<GenerateAltJobData> {
  if (!queue) {
    queue = new Queue<GenerateAltJobData>(GENERATE_ALT_QUEUE_NAME, {
      connection: queueConnection,
    });
  }

  return queue;
}

export async function enqueueGenerateAltJob(
  data: GenerateAltJobData,
): Promise<void> {
  await getGenerateAltQueue().add("generate_alt", data, {
    jobId: `${data.batchId}:${data.candidateId}`,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 2_000 },
  });

  logger.info(data, "generate-alt.queue.enqueued");
}
