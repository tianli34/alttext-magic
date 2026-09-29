/**
 * File: server/sse/writeback-truth-debug.publisher.ts
 * Purpose: 写回真值复核调试事件 Redis 发布器（仅 WRITEBACK_TRUTH_DEBUG=true 时生效）。
 *
 * 写回 Worker 在每次真值复核完成后发布复核结果事件，
 * 由 web 端 SSE（/api/writeback/truth-debug）按批次频道订阅并转发给前端弹窗，
 * 用于人工对照 Shopify 后台确认真值复核是否正确。
 *
 * 调试通道约定：
 *   - WRITEBACK_TRUTH_DEBUG 未开启时静默跳过，零开销；
 *   - 任何发布异常均被吞掉并记录日志，绝不影响写回主链路。
 */
import { env } from "../config/env";
import { queueConnection } from "../queues/connection";
import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "writeback-truth-debug-publisher" });

/** Redis Pub/Sub 频道前缀，按写回批次维度划分 */
const WRITEBACK_TRUTH_DEBUG_CHANNEL_PREFIX = "writeback:truth-debug:events";

/** 构造写回批次对应的真值复核调试频道 */
export function getWritebackTruthDebugChannel(batchId: string): string {
  return `${WRITEBACK_TRUTH_DEBUG_CHANNEL_PREFIX}:${batchId}`;
}

/** 真值复核后写回 Worker 的处置动作（与 processWritebackJob 的实际分支一一对应） */
export type WritebackTruthDebugAction =
  | "WRITE"
  | "ALREADY_WRITTEN_BY_SELF"
  | "SKIP_ALREADY_FILLED";

/** 真值复核调试事件 payload（SSE 原样转发给前端） */
export interface WritebackTruthDebugEvent {
  /** 事件类型：真值复核结果 */
  type: "truth_check";
  /** 写回批次 ID */
  batchId: string;
  /** 候选 ID */
  candidateId: string;
  /** Alt 平面（AltPlane 枚举字符串：FILE_ALT / COLLECTION_IMAGE_ALT / ARTICLE_IMAGE_ALT） */
  altPlane: string;
  /** Shopify 资源 GID（writeTargetId） */
  writeTargetId: string;
  /** 复核到的线上当前 Alt Text（资源不存在或为空时为 null） */
  currentAlt: string | null;
  /** 线上 Alt 是否为空（复核判定依据） */
  isEmpty: boolean;
  /** 资源是否已被从 Shopify 删除（node 返回 null） */
  isDeleted: boolean;
  /** 复核后的处置动作：缺失 → 写回；已填充且与待写文本一致 → 自写幂等成功；其余 → 跳过 */
  action: WritebackTruthDebugAction;
  /** 第几次执行（1 = 首次投递，>1 = BullMQ 重试）；用于识别重试链路的复核结果漂移 */
  attempt: number;
  /** 复核时间（ISO 8601，Worker 时钟） */
  checkedAt: string;
}

/** 发布事件入参：type / checkedAt 由发布器统一补齐 */
export type WritebackTruthDebugInput = Omit<
  WritebackTruthDebugEvent,
  "type" | "checkedAt"
>;

/**
 * 发布一条真值复核调试事件到批次频道。
 *
 * WRITEBACK_TRUTH_DEBUG 未开启时直接返回；
 * 发布失败仅记录警告，不向调用方抛错（调试通道不得影响写回主链路）。
 */
export async function publishWritebackTruthDebug(
  event: WritebackTruthDebugInput,
): Promise<void> {
  if (!env.WRITEBACK_TRUTH_DEBUG) return;

  try {
    const payload: WritebackTruthDebugEvent = {
      ...event,
      type: "truth_check",
      checkedAt: new Date().toISOString(),
    };

    await queueConnection.publish(
      getWritebackTruthDebugChannel(event.batchId),
      JSON.stringify(payload),
    );
  } catch (error) {
    logger.warn(
      {
        batchId: event.batchId,
        candidateId: event.candidateId,
        err: error,
      },
      "writeback truth debug publish failed",
    );
  }
}
