/**
 * File: app/hooks/useWritebackTruthDebug.ts
 * Purpose: 写回真值复核调试 SSE 连接 Hook（调试专用）。
 *          仅当服务端 WRITEBACK_TRUTH_DEBUG=true 时端点可用：
 *          实时收集写回 Worker 的真值复核结果事件，供调试弹窗人工核对。
 *          开关关闭（端点 404）时标记 disabled 并停止连接，不弹任何内容。
 */
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  EventStreamContentType,
  fetchEventSource,
  type EventSourceMessage,
} from "@microsoft/fetch-event-source";
import { useCallback, useEffect, useRef, useState } from "react";

/** 真值复核后写回 Worker 的处置动作 */
export type WritebackTruthDebugAction =
  | "WRITE"
  | "ALREADY_WRITTEN_BY_SELF"
  | "SKIP_ALREADY_FILLED";

/** 真值复核调试事件（与服务端 WritebackTruthDebugEvent 对齐） */
export interface WritebackTruthDebugEvent {
  type: "truth_check";
  batchId: string;
  candidateId: string;
  altPlane: string;
  writeTargetId: string;
  currentAlt: string | null;
  isEmpty: boolean;
  isDeleted: boolean;
  action: WritebackTruthDebugAction;
  /** 第几次执行（1 = 首次投递，>1 = BullMQ 重试） */
  attempt: number;
  checkedAt: string;
}

interface UseWritebackTruthDebugReturn {
  /** 已收到的复核结果事件（按到达顺序累加，最多保留最近 MAX_EVENTS 条） */
  events: WritebackTruthDebugEvent[];
  /** SSE 是否已连接 */
  connected: boolean;
  /** 调试开关未开启或批次不可用（端点 404）：调用方据此不展示调试弹窗 */
  disabled: boolean;
}

/** 事件上限：防止超大批次无限累积（超出后保留最新的） */
const MAX_EVENTS = 200;

const RECONNECT_DELAY_MS = 3_000;

/** 端点 404（调试开关关闭 / 批次不存在）时不再重连 */
class TruthDebugDisabledError extends Error {
  constructor() {
    super("Writeback truth debug disabled");
    this.name = "TruthDebugDisabledError";
  }
}

export function useWritebackTruthDebug(
  batchId: string | null,
): UseWritebackTruthDebugReturn {
  const shopify = useAppBridge();
  const [events, setEvents] = useState<WritebackTruthDebugEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 记录当前批次：重连时不清空已收集事件，仅批次切换时重置 */
  const lastBatchIdRef = useRef<string | null>(null);

  const handleMessage = useCallback((event: EventSourceMessage) => {
    if (event.event === "close") {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setConnected(false);
      return;
    }

    if (event.event !== "truth_check") return;

    try {
      const data = JSON.parse(event.data) as WritebackTruthDebugEvent;
      setEvents((current) => {
        const next = [...current, data];
        return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
      });
    } catch {
      // 忽略异常消息
    }
  }, []);

  const connect = useCallback(async () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    if (!batchId) {
      setConnected(false);
      setEvents([]);
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const token = await shopify.idToken();
      const url = `/api/writeback/truth-debug?batchId=${encodeURIComponent(batchId)}`;

      await fetchEventSource(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: abortController.signal,
        openWhenHidden: true,
        onopen: async (response) => {
          if (response.status === 404) {
            throw new TruthDebugDisabledError();
          }

          if (response.status === 401) {
            throw new Error("writeback truth debug unauthorized");
          }

          if (!response.ok) {
            throw new Error(`真值复核调试连接失败 (${response.status})`);
          }

          const contentType = response.headers.get("content-type");
          if (!contentType?.startsWith(EventStreamContentType)) {
            throw new Error("真值复核调试响应格式错误");
          }

          setConnected(true);
          setDisabled(false);
        },
        onmessage: handleMessage,
        onclose: () => {
          setConnected(false);
        },
        onerror: (streamError) => {
          setConnected(false);
          if (streamError instanceof TruthDebugDisabledError) {
            throw streamError;
          }
          throw streamError;
        },
      });
    } catch (streamError) {
      setConnected(false);

      if (streamError instanceof TruthDebugDisabledError) {
        setDisabled(true);
        return;
      }

      if (!abortController.signal.aborted) {
        reconnectTimerRef.current = setTimeout(() => {
          setRetryCount((current) => current + 1);
        }, RECONNECT_DELAY_MS);
      }
    }
  }, [batchId, handleMessage, shopify]);

  useEffect(() => {
    // 仅批次切换时清空上一批次的复核事件（重连应保留已收到的结果）
    if (lastBatchIdRef.current !== batchId) {
      lastBatchIdRef.current = batchId;
      setEvents([]);
      setDisabled(false);
    }

    void connect();

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [connect, retryCount]);

  return { events, connected, disabled };
}
