/**
 * File: app/hooks/useWritebackSSE.ts
 * Purpose: 写回阶段进度连接 Hook。
 *          SSE(/api/writeback/progress)为主、DB 快照轮询(/api/writeback/batch/:batchId)为兜底的
 *          混合模式,与扫描进度 useBatchProgress 的容灾策略保持一致。
 *
 *          为什么需要轮询兜底:
 *            开发环境经 Cloudflare Tunnel(cloudflared 快速隧道)访问时,边缘会缓冲
 *            text/event-stream 响应体,流保持打开期间前端收不到任何事件(实测
 *            RUNNING 批次每 2s 推送、16s 内 0 chunk;流关闭时缓冲才一次性冲刷),
 *            导致写回进度弹窗长时间停留在「连接中…0 / 0 已完成」。
 *            轮询为普通请求-响应,不受缓冲影响;SSE 到达时仍可实时覆盖进度。
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
/** 进度快照轮询间隔(兜底通道,普通请求不受隧道缓冲影响) */
const POLL_INTERVAL_MS = 3_000;
/** SSE 数据新鲜度窗口:窗口内轮询不得覆盖更新的 SSE 快照 */
const SSE_FRESH_MS = 10_000;

function isTerminalStatus(status: WritebackBatchStatus | undefined): boolean {
  return status === "SUCCESS" || status === "PARTIAL_SUCCESS" || status === "FAILED";
}

/** 从批次详情响应中提取进度快照字段(详情接口返回体为进度快照的超集) */
function toProgressData(detail: WritebackProgressData): WritebackProgressData {
  return {
    batchId: detail.batchId,
    status: detail.status,
    total: detail.total,
    success: detail.success,
    fail: detail.fail,
    skip: detail.skip,
    pending: detail.pending,
  };
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
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // 进度镜像与来源追踪:progressRef 供定时器/回调读取最新值;
  // lastSSEDataAtRef 记录最近一次 SSE 快照到达时间,用于轮询避让。
  const progressRef = useRef<WritebackProgressData | null>(null);
  const lastSSEDataAtRef = useRef(0);
  // 终态完成回调只允许触发一次(SSE complete 与轮询兜底可能先后到达)
  const completedRef = useRef(false);
  const batchIdRef = useRef<string | null>(batchId);
  batchIdRef.current = batchId;

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
      progressRef.current = data;
      lastSSEDataAtRef.current = Date.now();
      setProgress(data);

      if (event.event === "complete" && !completedRef.current) {
        completedRef.current = true;
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
      setProgress(null);
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

  // ---- 轮询兜底:普通请求获取 DB 快照,SSE 数据新鲜时主动避让 ----
  const pollOnce = useCallback(async () => {
    const currentBatchId = batchIdRef.current;
    if (!currentBatchId || completedRef.current) return;

    // 进度已到终态:无需继续轮询
    if (isTerminalStatus(progressRef.current?.status)) return;

    try {
      const token = await shopify.idToken();
      const response = await fetch(
        `/api/writeback/batch/${encodeURIComponent(currentBatchId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      // 批次不存在(404):静默跳过,等待下次轮询/SSE 给出结论
      if (!response.ok) return;

      const detail = (await response.json()) as WritebackProgressData;
      const snapshot = toProgressData(detail);

      // SSE 数据仍新鲜时以 SSE 为准,避免旧快照回退进度条
      const sseStale =
        Date.now() - lastSSEDataAtRef.current > SSE_FRESH_MS ||
        progressRef.current === null;
      if (sseStale) {
        progressRef.current = snapshot;
        setProgress(snapshot);
      }

      // 轮询先于缓冲的 SSE 到达终态时,由轮询兜底触发完成回调
      if (isTerminalStatus(snapshot.status) && !completedRef.current) {
        completedRef.current = true;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        setConnected(false);
        onCompleteRef.current?.(snapshot);
      }
    } catch {
      // 轮询失败静默跳过:错误展示交给 SSE 通道,下一轮重试
    }
  }, [shopify]);

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

  // 轮询定时器:仅在有批次且未完成时运行
  useEffect(() => {
    if (!batchId) {
      return;
    }

    void pollOnce();
    pollTimerRef.current = setInterval(() => {
      void pollOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [batchId, pollOnce]);

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
