/**
 * File: app/hooks/useGenerationSSE.ts
 * Purpose: 生成阶段 SSE 连接 Hook。
 *          连接 GET /api/generation/progress/:batchId 端点，
 *          实时接收生成进度事件并更新状态。
 *          复用 @microsoft/fetch-event-source 实现 SSE 连接管理。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  EventStreamContentType,
  fetchEventSource,
  type EventSourceMessage,
} from "@microsoft/fetch-event-source";

/** 生成进度 SSE 事件数据 */
export interface GenerationProgressData {
  /** 事件类型 */
  type: "generation_progress" | "generation_completed";
  /** 批次 ID */
  batchId: string;
  /** 已处理条目数 */
  current: number;
  /** 总条目数 */
  total: number;
  /** 跳过数 */
  skipped: number;
  /** 失败数 */
  failed: number;
  /** 批次状态 */
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
}

class SSEUnauthorizedError extends Error {
  constructor() {
    super("SSE unauthorized");
    this.name = "SSEUnauthorizedError";
  }
}

const RECONNECT_DELAY_MS = 3_000;

interface UseGenerationSSEReturn {
  /** 当前进度数据，连接前为 null */
  progress: GenerationProgressData | null;
  /** 是否正在连接中 */
  connected: boolean;
  /** 连接错误 */
  error: string | null;
  /** 手动重连 */
  reconnect: () => void;
  /** 进度百分比 0-100 */
  percent: number;
  /** 是否已完成（COMPLETED 或 FAILED） */
  isTerminal: boolean;
}

/**
 * 生成阶段 SSE 连接 Hook。
 *
 * @param batchId 批次 ID，null 时不连接
 * @param onCompleted 可选回调，到达终态时触发
 */
export function useGenerationSSE(
  batchId: string | null,
  onCompleted?: (data: GenerationProgressData) => void,
): UseGenerationSSEReturn {
  const shopify = useAppBridge();
  const [progress, setProgress] = useState<GenerationProgressData | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  const handleMessage = useCallback((event: EventSourceMessage) => {
    if (event.event === "close") {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      setConnected(false);
      return;
    }

    if (
      event.event !== "generation_progress" &&
      event.event !== "generation_completed"
    ) {
      return;
    }

    try {
      const data = JSON.parse(event.data) as GenerationProgressData;
      setProgress(data);

      // 终态时关闭连接
      if (event.event === "generation_completed") {
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setConnected(false);
        onCompletedRef.current?.(data);
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

    if (!batchId) {
      setConnected(false);
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const url = `/api/generation/progress/${encodeURIComponent(batchId)}`;

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
  }, [handleMessage, batchId, shopify]);

  // batchId 变化时重连
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

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  const isTerminal =
    progress?.status === "COMPLETED" || progress?.status === "FAILED";

  return { progress, connected, error, reconnect, percent, isTerminal };
}
