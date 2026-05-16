/**
 * File: server/sse/generation-sse.service.ts
 * Purpose: 生成阶段 SSE 推送服务。
 *          通过 Redis Pub/Sub 订阅实时进度事件并推送给前端。
 *          连接建立时先发送当前快照，再订阅后续增量事件。
 *          到达终态（COMPLETED / FAILED）或客户端断开时自动清理。
 */
import { queueConnection } from "../queues/connection";
import {
  getGenerationProgressChannel,
  readGenerationProgress,
  type GenerationProgressEvent,
} from "./progress-publisher";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "generation-sse-service" });

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** Writer 接口：适配 ReadableStreamDefaultController */
export interface SSEWriter {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 启动生成进度 SSE 流。
 *
 * 流程:
 *   1. 读取 Redis hash 快照 → 发送初始事件
 *   2. 订阅 Redis Pub/Sub 频道 → 实时转发
 *   3. 收到 generation_completed 事件 → 发送后停止
 *   4. 客户端断开 → 取消订阅并释放连接
 *
 * @param batchId 批次 ID
 * @param writer SSE 流写入器
 * @returns 清理函数，调用可提前停止订阅并释放资源
 */
export function startGenerationSSEStream(
  batchId: string,
  writer: SSEWriter,
): () => void {
  let stopped = false;
  const encoder = new TextEncoder();
  const channel = getGenerationProgressChannel(batchId);

  /** 创建独立的 Redis 订阅连接（subscribe 模式不能执行普通命令） */
  const subscriber = queueConnection.duplicate();

  /** 写入 SSE 事件 */
  async function sendEvent(
    eventName: string,
    data: GenerationProgressEvent,
  ): Promise<void> {
    if (stopped) return;
    const payload = JSON.stringify(data);
    const chunk = encoder.encode(`event: ${eventName}\ndata: ${payload}\n\n`);
    await writer.write(chunk);
  }

  /** 写入 SSE 心跳 */
  async function sendHeartbeat(): Promise<void> {
    if (stopped) return;
    const chunk = encoder.encode(":heartbeat\n\n");
    await writer.write(chunk);
  }

  /** 发送关闭事件并清理 */
  async function sendClose(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatInterval);

    try {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    } catch {
      // 订阅连接可能已关闭
    }

    try {
      const closeChunk = encoder.encode("event: close\ndata: {}\n\n");
      await writer.write(closeChunk);
      await writer.close();
    } catch {
      // 流可能已关闭
    }

    logger.info({ batchId }, "Generation SSE stream closed");
  }

  /** 处理 Pub/Sub 消息 */
  async function handleMessage(
    _channelName: string,
    message: string,
  ): Promise<void> {
    if (stopped) return;

    try {
      const event = JSON.parse(message) as GenerationProgressEvent;

      if (event.type === "generation_completed") {
        // 终态汇总事件：发送后关闭流
        await sendEvent("generation_completed", event);
        await sendClose();
        return;
      }

      // 常规进度事件
      await sendEvent("generation_progress", event);
    } catch (error) {
      logger.error(
        {
          batchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to parse generation progress message",
      );
    }
  }

  // 心跳定时器
  const heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(() => {
      stopped = true;
    });
  }, HEARTBEAT_INTERVAL_MS);

  // 启动异步初始化（不 await）
  (async () => {
    try {
      // 1. 发送当前快照
      const snapshot = await readGenerationProgress(batchId);
      if (snapshot) {
        const initialEvent: GenerationProgressEvent = {
          type: "generation_progress",
          batchId,
          current: snapshot.completedTasks,
          total: snapshot.totalTasks,
          skipped: snapshot.skippedTasks,
          failed: snapshot.failedTasks,
          status: snapshot.status as GenerationProgressEvent["status"],
        };
        await sendEvent("generation_progress", initialEvent);

        // 如果快照已是终态，直接关闭
        if (snapshot.status === "COMPLETED" || snapshot.status === "FAILED") {
          const completedEvent: GenerationProgressEvent = {
            type: "generation_completed",
            batchId,
            current: snapshot.completedTasks,
            total: snapshot.totalTasks,
            skipped: snapshot.skippedTasks,
            failed: snapshot.failedTasks,
            status: snapshot.status as GenerationProgressEvent["status"],
          };
          await sendEvent("generation_completed", completedEvent);
          await sendClose();
          return;
        }
      }

      // 2. 订阅 Redis Pub/Sub 频道
      subscriber.on("message", (ch, msg) => {
        if (ch === channel) {
          void handleMessage(ch, msg);
        }
      });
      await subscriber.subscribe(channel);

      logger.info({ batchId, channel }, "Generation SSE subscribed to Redis channel");
    } catch (error) {
      logger.error(
        {
          batchId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Generation SSE stream initialization failed",
      );
      await sendClose();
    }
  })();

  // 返回外部清理函数（客户端断开时调用）
  return () => {
    if (!stopped) {
      logger.info({ batchId }, "Generation SSE stream externally cleaned up");
    }
    stopped = true;
    clearInterval(heartbeatInterval);

    // 异步清理订阅连接，不阻塞
    subscriber
      .unsubscribe(channel)
      .catch(() => {})
      .then(() => subscriber.quit().catch(() => {}));
  };
}
