/**
 * File: server/sse/writeback-truth-debug-sse.service.ts
 * Purpose: 写回真值复核调试 SSE 推送服务（仅 WRITEBACK_TRUTH_DEBUG=true 的端点会启用）。
 *
 * 通过 Redis Pub/Sub 订阅真值复核调试事件并实时转发给前端弹窗；
 * 另以低频轮询写回批次状态作为兜底：批次进入终态（或批次不存在）时关闭流，
 * 避免依赖 Worker 是否发布"完成"信号。
 */
import { queueConnection } from "../queues/connection";
import {
  getWritebackProgressSnapshot,
  isWritebackBatchTerminal,
} from "../modules/writeback/writeback-batch.service";
import {
  getWritebackTruthDebugChannel,
  type WritebackTruthDebugEvent,
} from "./writeback-truth-debug.publisher";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "writeback-truth-debug-sse-service" });

/** 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** 批次终态兜底轮询间隔（毫秒）：事件转发靠 Pub/Sub 实时驱动，轮询仅保证流最终收敛 */
const BATCH_POLL_INTERVAL_MS = 5_000;

export interface SSEWriter {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 启动写回真值复核调试 SSE 流。
 *
 * @param shopId 店铺 ID（轮询兜底时用于批次归属校验）
 * @param batchId 写回批次 ID（决定订阅的 Pub/Sub 频道）
 * @param writer SSE 流写入器
 * @returns 清理函数，调用可提前停止订阅并释放资源
 */
export function startWritebackTruthDebugSSEStream(
  shopId: string,
  batchId: string,
  writer: SSEWriter,
): () => void {
  let stopped = false;
  const encoder = new TextEncoder();
  const channel = getWritebackTruthDebugChannel(batchId);

  /** 创建独立的 Redis 订阅连接（subscribe 模式不能执行普通命令） */
  const subscriber = queueConnection.duplicate();

  /** 写入一条真值复核调试事件 */
  async function sendEvent(event: WritebackTruthDebugEvent): Promise<void> {
    if (stopped) return;
    const chunk = encoder.encode(
      `event: truth_check\ndata: ${JSON.stringify(event)}\n\n`,
    );
    await writer.write(chunk);
  }

  /** 写入 SSE 心跳 */
  async function sendHeartbeat(): Promise<void> {
    if (stopped) return;
    const chunk = encoder.encode(":heartbeat\n\n");
    await writer.write(chunk);
  }

  /** 发送关闭事件并清理订阅与定时器 */
  async function closeStream(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatInterval);
    clearInterval(batchPollInterval);

    try {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    } catch {
      // 订阅连接可能已关闭
    }

    try {
      await writer.write(encoder.encode("event: close\ndata: {}\n\n"));
      await writer.close();
    } catch {
      // 流可能已关闭
    }

    logger.info({ shopId, batchId }, "writeback truth debug SSE stream closed");
  }

  /** 兜底轮询：批次终态或不存在时关闭流 */
  async function pollBatchStatus(): Promise<void> {
    if (stopped) return;

    try {
      const snapshot = await getWritebackProgressSnapshot(shopId, batchId);
      if (!snapshot || isWritebackBatchTerminal(snapshot.status)) {
        await closeStream();
      }
    } catch (error) {
      logger.error(
        { shopId, batchId, err: error },
        "writeback truth debug SSE batch poll failed",
      );
    }
  }

  // 处理 Pub/Sub 消息：解析后原样转发
  subscriber.on("message", (_channelName, message) => {
    if (stopped) return;

    try {
      const event = JSON.parse(message) as WritebackTruthDebugEvent;
      void sendEvent(event);
    } catch (error) {
      logger.error(
        { batchId, err: error },
        "writeback truth debug SSE message parse failed",
      );
    }
  });

  const heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(() => {
      stopped = true;
    });
  }, HEARTBEAT_INTERVAL_MS);

  const batchPollInterval = setInterval(() => {
    void pollBatchStatus();
  }, BATCH_POLL_INTERVAL_MS);

  // 启动订阅（异步初始化，不阻塞返回）
  void subscriber
    .subscribe(channel)
    .then(() => {
      logger.info({ shopId, batchId, channel }, "writeback truth debug SSE subscribed");
    })
    .catch(async (error) => {
      logger.error(
        { shopId, batchId, err: error },
        "writeback truth debug SSE subscribe failed",
      );
      await closeStream();
    });

  // 返回外部清理函数（客户端断开时调用）
  return () => {
    if (!stopped) {
      logger.info({ shopId, batchId }, "writeback truth debug SSE externally cleaned up");
    }
    stopped = true;
    clearInterval(heartbeatInterval);
    clearInterval(batchPollInterval);

    subscriber
      .unsubscribe(channel)
      .catch(() => {})
      .then(() => subscriber.quit().catch(() => {}));
  };
}
