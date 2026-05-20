/**
 * File: app/hooks/useWritebackSSE.ts
 * Purpose: 写回阶段 SSE 连接 Hook。
 */
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  EventStreamContentType,
  fetchEventSource,
  type EventSourceMessage,
} from "@microsoft/fetch-event-source";
import { useCallback, useEffect, useRef, useState } from "react";

export type WritebackBatchStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "FAILED";

export interface WritebackProgressData {
  batchId: string;
  status: WritebackBatchStatus;
  total: number;
  success: number;
  fail: number;
  skip: number;
  pending: number;
}

interface UseWritebackSSEReturn {
  progress: WritebackProgressData | null;
  connected: boolean;
  error: string | null;
  percent: number;
  isTerminal: boolean;
  reconnect: () => void;
}

class WritebackSSEUnauthorizedError extends Error {
  constructor() {
    super("Writeback SSE unauthorized");
    this.name = "WritebackSSEUnauthorizedError";
  }
}

const RECONNECT_DELAY_MS = 3_000;

function isTerminalStatus(status: WritebackBatchStatus | undefined): boolean {
  return status === "SUCCESS" || status === "PARTIAL_SUCCESS" || status === "FAILED";
}

export function useWritebackSSE(
  batchId: string | null,
  onComplete?: (data: WritebackProgressData) => void,
): UseWritebackSSEReturn {
  const shopify = useAppBridge();
  const [progress, setProgress] = useState<WritebackProgressData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const handleMessage = useCallback((event: EventSourceMessage) => {
    if (event.event === "close") {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setConnected(false);
      return;
    }

    if (event.event !== "progress" && event.event !== "complete") return;

    try {
      const data = JSON.parse(event.data) as WritebackProgressData;
      setProgress(data);

      if (event.event === "complete") {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setConnected(false);
        onCompleteRef.current?.(data);
      }
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
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const token = await shopify.idToken();
      const url = `/api/writeback/progress?batchId=${encodeURIComponent(batchId)}`;

      await fetchEventSource(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: abortController.signal,
        openWhenHidden: true,
        onopen: async (response) => {
          if (response.status === 401) {
            throw new WritebackSSEUnauthorizedError();
          }

          if (!response.ok) {
            throw new Error(`写回进度连接失败 (${response.status})`);
          }

          const contentType = response.headers.get("content-type");
          if (!contentType?.startsWith(EventStreamContentType)) {
            throw new Error("写回进度响应格式错误");
          }

          setConnected(true);
          setError(null);
        },
        onmessage: handleMessage,
        onclose: () => {
          setConnected(false);
        },
        onerror: (streamError) => {
          setConnected(false);
          if (streamError instanceof WritebackSSEUnauthorizedError) {
            setError("登录状态已过期，请刷新后重试");
            throw streamError;
          }

          setError("写回进度连接中断，正在重连");
          throw streamError;
        },
      });
    } catch (streamError) {
      if (!abortController.signal.aborted) {
        if (streamError instanceof WritebackSSEUnauthorizedError) {
          setError("登录状态已过期，请刷新后重试");
        } else {
          setError("写回进度连接失败，正在重连");
          reconnectTimerRef.current = setTimeout(() => {
            setRetryCount((current) => current + 1);
          }, RECONNECT_DELAY_MS);
        }
      }
      setConnected(false);
    }
  }, [batchId, handleMessage, shopify]);

  useEffect(() => {
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

  const reconnect = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setRetryCount((current) => current + 1);
  }, []);

  const percent = progress && progress.total > 0
    ? Math.round(((progress.success + progress.fail + progress.skip) / progress.total) * 100)
    : 0;

  return {
    progress,
    connected,
    error,
    percent,
    isTerminal: isTerminalStatus(progress?.status),
    reconnect,
  };
}
