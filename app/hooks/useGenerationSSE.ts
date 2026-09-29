/**
 * File: app/hooks/useGenerationSSE.ts
 * Purpose: 生成阶段进度连接 Hook。
 *          主通道：SSE GET /api/generation/progress/:batchId（@microsoft/fetch-event-source）。
 *          兜底通道：轮询 GET /api/generation/batch/:batchId 读取同口径 DB 快照。
 *
 *          为什么必须加轮询兜底：
 *          SSE 依赖长连接流式冲刷。开发环境经 Cloudflare Tunnel(cloudflared) 访问时，
 *          边缘节点会整体缓冲 text/event-stream 响应体——流保持打开的整个期间前端收到
 *          0 个 chunk，只有流关闭时才一次性冲刷（写回阶段实测：服务端每 2s 推送、
 *          16s 内 0 chunk，见 app/hooks/useWritebackSSE.ts 头部说明）。
 *          生成阶段此前只有 SSE，因此进度条全程停在首帧快照的「0 / N 已完成」，
 *          而后端 generation_batch 计数、额度结算、自动写回其实正常推进。
 *          轮询是普通请求-响应，不受流式缓冲影响；SSE 正常时仍以 SSE 实时事件为准。
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
  /** 自动触发的写回批次 ID（尚未触发/无需写回时为 null） */
  writebackBatchId?: string | null;
  /** 自动写回未能启动时的错误码（成功时为 null） */
  writebackError?: string | null;
}

class SSEUnauthorizedError extends Error {
  constructor() {
    super("SSE unauthorized");
    this.name = "SSEUnauthorizedError";
  }
}

const RECONNECT_DELAY_MS = 3_000;
/** 进度轮询兜底间隔：与写回进度保持一致的 3s 节奏 */
const POLL_INTERVAL_MS = 3_000;
/** SSE 新鲜期：该窗口内收到过 SSE 进度事件即视为流是通的，轮询结果不覆盖 SSE */
const SSE_FRESH_MS = 10_000;

/** 轮询接口返回的进度快照（字段与 SSE 事件一致，type 由本 Hook 注入） */
export type GenerationProgressSnapshot = Omit<GenerationProgressData, "type">;

/** 批次是否已进入终态 */
function isTerminalStatus(status: GenerationProgressData["status"] | undefined): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

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
  const prevBatchIdRef = useRef<string | null | undefined>(undefined);
  const abortControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;

  // 进度镜像与来源时间戳：轮询回调是 setInterval 闭包，需通过 ref 读取最新进度，
  // 并据「最近一次 SSE 事件时间」判定 SSE 是否仍在正常推送，避免轮询覆盖更实的 SSE 数据。
  const progressRef = useRef<GenerationProgressData | null>(null);
  const lastSSEProgressAtRef = useRef(0);
  const batchIdRef = useRef<string | null>(batchId);
  batchIdRef.current = batchId;
  const completedRef = useRef(false);

  /** 写入进度并同步镜像（两个通道共用同一渲染字段，UI 无需区分来源） */
  const applyProgress = useCallback((data: GenerationProgressData) => {
    progressRef.current = data;
    setProgress(data);
  }, []);

  /** 终态收敛：只触发一次完成回调，并停掉两个通道 */
  const finalizeOnce = useCallback((data: GenerationProgressData) => {
    if (completedRef.current) return;
    completedRef.current = true;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setConnected(false);
    onCompletedRef.current?.(data);
  }, []);

  const handleMessage = useCallback(
    (event: EventSourceMessage) => {
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
        lastSSEProgressAtRef.current = Date.now();
        applyProgress(data);

        // 终态时关闭连接
        if (
          event.event === "generation_completed" ||
          isTerminalStatus(data.status)
        ) {
          finalizeOnce(data);
        }
      } catch {
        // 解析失败忽略
      }
    },
    [applyProgress, finalizeOnce],
  );

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

  /**
   * 轮询兜底：读取与 SSE 同口径的 DB 进度快照。
   * SSE 事件被隧道/代理整体缓冲时（流未关闭前 0 chunk），仅靠 SSE 会让进度停在首帧的 0；
   * 轮询是普通请求-响应，不受流式缓冲影响。SSE 新鲜期内不覆盖其数据，仅用于判定终态。
   */
  const pollOnce = useCallback(async () => {
    const currentBatchId = batchIdRef.current;
    if (!currentBatchId || completedRef.current) return;
    if (isTerminalStatus(progressRef.current?.status)) return;

    try {
      const token = await shopify.idToken();
      const response = await fetch(
        `/api/generation/batch/${encodeURIComponent(currentBatchId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      );
      // 轮询失败静默处理：SSE 通道可能仍在推送，下一轮再试
      if (!response.ok) return;

      const snapshot = (await response.json()) as GenerationProgressSnapshot;
      // 响应返回时批次可能已切换或已终态，丢弃过期快照
      if (batchIdRef.current !== currentBatchId || completedRef.current) return;

      const data: GenerationProgressData = {
        ...snapshot,
        type: isTerminalStatus(snapshot.status)
          ? "generation_completed"
          : "generation_progress",
      };

      const sseStalled =
        progressRef.current === null ||
        Date.now() - lastSSEProgressAtRef.current > SSE_FRESH_MS;
      if (sseStalled) {
        applyProgress(data);
      }

      // 服务端计数已终态：无论 SSE 是否通着，都以它为准收敛（否则界面会一直卡在生成中）
      if (isTerminalStatus(snapshot.status)) {
        finalizeOnce(data);
      }
    } catch {
      // idToken 获取失败或网络异常：等待下一轮轮询
    }
  }, [applyProgress, finalizeOnce, shopify]);

  // batchId 变化时重连
  useEffect(() => {
    // 仅当 batchId 真正切换（含回到 null）时清空上一轮进度快照，
    // 避免新一轮生成开始时短暂显示上次的进度结果。
    if (prevBatchIdRef.current !== batchId) {
      prevBatchIdRef.current = batchId;
      progressRef.current = null;
      lastSSEProgressAtRef.current = 0;
      completedRef.current = false;
      setProgress(null);
      setConnected(false);
      setError(null);
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

  // 轮询兜底定时器：批次存在期间立即拉一次并周期刷新（终态后 pollOnce 自行短路）
  useEffect(() => {
    if (!batchId) return;

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
