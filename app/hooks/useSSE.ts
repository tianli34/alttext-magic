/**
 * File: app/hooks/useSSE.ts
 * Purpose: SSE 连接 Hook。
 *          连接 GET /api/sse?scanJobId=... 端点，
 *          实时接收进度事件并更新状态。
 */
import { useState, useEffect, useCallback, useRef } from "react";

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

/** 终态阶段集合 */
const TERMINAL_PHASES = new Set(["done", "failed", "unknown"]);

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
  const [progress, setProgress] = useState<SSEProgressData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const connect = useCallback(() => {
    // 清理旧连接
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (!scanJobId) {
      setConnected(false);
      return;
    }

    const url = `/api/sse?scanJobId=${encodeURIComponent(scanJobId)}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.addEventListener("progress", (event: MessageEvent) => {
      try {
        const data: SSEProgressData = JSON.parse(event.data);
        setProgress(data);

        // 终态时关闭连接
        if (TERMINAL_PHASES.has(data.phase)) {
          es.close();
          eventSourceRef.current = null;
          setConnected(false);
          onTerminalRef.current?.(data);
        }
      } catch {
        // 解析失败忽略
      }
    });

    es.addEventListener("close", () => {
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
    });

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
      setError("SSE 连接中断");
    };
  }, [scanJobId]);

  // scanJobId 变化时重连
  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connect, retryCount]);

  const reconnect = useCallback(() => {
    setRetryCount((prev) => prev + 1);
  }, []);

  return { progress, connected, error, reconnect };
}
