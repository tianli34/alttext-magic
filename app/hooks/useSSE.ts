/**
 * File: app/hooks/useSSE.ts
 * Purpose: SSE 连接 Hook。
 *          连接 GET /api/sse?scanJobId=... 端点，
 *          实时接收进度事件并更新状态。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  EventStreamContentType,
  fetchEventSource,
  type EventSourceMessage,
} from "@microsoft/fetch-event-source";

/** SSE 进度事件数据 */
export interface SSEProgressData {
  type: "progress";
  completedTasks: number;
  totalTasks: number;
  status: string;
  phase: string;
  message: string;
  timestamp: string;
}

/** 终态阶段集合。unknown 仅表示 SSE 无法确认进度，不应直接视为任务终态。 */
const TERMINAL_PHASES = new Set(["done", "failed"]);
const RECONNECT_DELAY_MS = 3_000;

class SSEUnauthorizedError extends Error {
  constructor() {
    super("SSE unauthorized");
    this.name = "SSEUnauthorizedError";
  }
}

interface UseSSEReturn {
  /** 当前进度数据，连接前为 null */
  progress: SSEProgressData | null;
  /** 是否正在连接中 */
  connected: boolean;
  /** 连接错误 */
  error: string | null;
  /** 手动重连 */
  reconnect: () => void;
}

/**
 * SSE 连接 Hook。
 *
 * @param scanJobId 扫描任务 ID，null 时不连接
 * @param onTerminal 可选回调，到达终态时触发
 */
export function useSSE(
  scanJobId: string | null,
  onTerminal?: (data: SSEProgressData) => void,
): UseSSEReturn {
  const shopify = useAppBridge();
  const [progress, setProgress] = useState<SSEProgressData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const handleMessage = useCallback((event: EventSourceMessage) => {
    if (event.event === "close") {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setConnected(false);
      return;
    }

    if (event.event !== "progress") {
      return;
    }

    try {
      const data = JSON.parse(event.data) as SSEProgressData;
      setProgress(data);

      // 终态时关闭连接
      if (TERMINAL_PHASES.has(data.phase)) {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setConnected(false);
        onTerminalRef.current?.(data);
      }
    } catch {
      // 解析失败忽略
    }
  }, []);

  const connect = useCallback(async () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    abortControllerRef.current?.abort();
    abortControllerRef.current = null;

    if (!scanJobId) {
      setConnected(false);
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const url = `/api/sse?scanJobId=${encodeURIComponent(scanJobId)}`;

    try {
      const token = await shopify.idToken();

      await fetchEventSource(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: abortController.signal,
        openWhenHidden: true,
        onopen: async (response) => {
          if (response.status === 401) {
            throw new SSEUnauthorizedError();
          }

          if (!response.ok) {
            throw new Error(`SSE 请求失败 (${response.status})`);
          }

          const contentType = response.headers.get("content-type");
          if (!contentType?.startsWith(EventStreamContentType)) {
            throw new Error("SSE 响应格式错误");
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

          if (streamError instanceof SSEUnauthorizedError) {
            setError("登录状态已过期，请刷新后重试");
            throw streamError;
          }

          setError("SSE 连接中断，正在重连");
          throw streamError;
        },
      });
    } catch (streamError) {
      if (!abortController.signal.aborted) {
        if (streamError instanceof SSEUnauthorizedError) {
          setError("登录状态已过期，请刷新后重试");
        } else {
          setError("SSE 连接失败，正在重连");
          reconnectTimerRef.current = setTimeout(() => {
            setRetryCount((prev) => prev + 1);
          }, RECONNECT_DELAY_MS);
        }
      }
      setConnected(false);
    }
  }, [handleMessage, scanJobId, shopify]);

  // scanJobId 变化时重连
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
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setRetryCount((prev) => prev + 1);
  }, []);

  return { progress, connected, error, reconnect };
}
