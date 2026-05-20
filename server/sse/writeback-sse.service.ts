/**
 * File: server/sse/writeback-sse.service.ts
 * Purpose: 写回阶段 SSE 推送服务，通过 DB 轮询 JobBatch counts。
 */
import {
  getWritebackProgressSnapshot,
  isWritebackBatchTerminal,
  type WritebackProgressSnapshot,
} from "../modules/writeback/writeback-batch.service";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "writeback-sse-service" });
const POLL_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SSEWriter {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
}

export function startWritebackSSEStream(
  shopId: string,
  batchId: string,
  writer: SSEWriter,
): () => void {
  let stopped = false;
  const encoder = new TextEncoder();

  async function sendEvent(
    eventName: "progress" | "complete" | "close",
    data: WritebackProgressSnapshot | Record<string, never>,
  ): Promise<void> {
    if (stopped && eventName !== "close") return;
    await writer.write(
      encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }

  async function sendHeartbeat(): Promise<void> {
    if (!stopped) {
      await writer.write(encoder.encode(":heartbeat\n\n"));
    }
  }

  async function closeStream(): Promise<void> {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatInterval);

    try {
      await sendEvent("close", {});
      await writer.close();
    } catch {
      // 客户端可能已断开
    }
  }

  async function poll(): Promise<void> {
    while (!stopped) {
      try {
        const snapshot = await getWritebackProgressSnapshot(shopId, batchId);
        if (!snapshot) {
          await closeStream();
          return;
        }

        await sendEvent("progress", snapshot);

        if (isWritebackBatchTerminal(snapshot.status)) {
          await sendEvent("complete", snapshot);
          await closeStream();
          return;
        }
      } catch (error) {
        logger.error(
          {
            shopId,
            batchId,
            err: error,
          },
          "writeback.sse.poll-failed",
        );
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  const heartbeatInterval = setInterval(() => {
    sendHeartbeat().catch(() => {
      stopped = true;
      clearInterval(heartbeatInterval);
    });
  }, HEARTBEAT_INTERVAL_MS);

  void poll();

  return () => {
    stopped = true;
    clearInterval(heartbeatInterval);
  };
}
