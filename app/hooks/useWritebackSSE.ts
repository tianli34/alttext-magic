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
  /** 上一轮批次 ID：仅在批次真正切换（含回到 null）时重置通道状态 */
  const prevBatchIdRef = useRef<string | null | undefined>(undefined);
  /**
   * 轮询通道的会话代号：与 completedRef 的复位同处一个同步块递增。
   *
   * 为什么单靠 completedRef 拦不住：
   * 转入 SUMMARY 后传给本 Hook 的 batchId 变为 null，复位块把 completedRef 重新打开
   * （同一页面会话的下一轮一键处理需要它），但轮询的 fetch 不会随这次复位取消。
   * 响应若在复位之后才落地，pollOnce 只在 await 之后复查 completedRef（此刻已为
   * false），于是对同一批次二次触发终态回调（同批次二次回调会覆盖已落地的汇总）。
   * 会话代号在取数发起时捕获、落地时核对，使上一轮的响应即使迟到也被整份丢弃。
   */
  const pollRunIdRef = useRef(0);
  /** 在途轮询请求的取消句柄：批次切换（含回到 null）时中止，避免陈旧响应落地回写进度 */
  const pollAbortControllerRef = useRef<AbortController | null>(null);

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
    const runId = pollRunIdRef.current;
    const currentBatchId = batchIdRef.current;
    if (!currentBatchId || completedRef.current) return;

    // 进度已到终态:无需继续轮询
    if (isTerminalStatus(progressRef.current?.status)) return;

    // 本次取数是否仍属于当前轮次:批次切换（含回到 null）后会话代号递增，
    // 或入参批次 ID 已变（batchIdRef 在渲染期同步更新，失效点比复位块更早）
    const isStale = () =>
      pollRunIdRef.current !== runId || batchIdRef.current !== currentBatchId;

    const abortController = new AbortController();
    pollAbortControllerRef.current = abortController;

    try {
      const token = await shopify.idToken();
      if (isStale()) return;

      const response = await fetch(
        `/api/writeback/batch/${encodeURIComponent(currentBatchId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: abortController.signal,
        },
      );

      // 批次不存在(404):静默跳过,等待下次轮询/SSE 给出结论
      if (!response.ok) return;

      const detail = (await response.json()) as WritebackProgressData;

      // 每个 await 之后都必须复核归属:批次若在这期间切换（如终态已由 SSE 送达、
      // 写回批次 ID 归 null 转入汇总）或流程已 teardown,这份响应属于上一轮,
      // 既不回写进度也不触发终态回调——复位块已把 completedRef 重新打开,
      // 单靠它拦不住这次迟到
      if (isStale()) return;

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
    } finally {
      if (pollAbortControllerRef.current === abortController) {
        pollAbortControllerRef.current = null;
      }
    }
  }, [shopify]);

  useEffect(() => {
    // 批次切换（含回到 null）时必须重置通道状态：
    // completedRef 是「终态回调只触发一次」的闸门，若跨批次沿用，同一页面会话里
    // 第二次一键处理的 complete 事件与轮询兜底都会被旧闸门挡掉（progressRef 还停在
    // 上一轮的终态，pollOnce 开头即短路），汇总弹窗不再自动弹出、进度浮层永久停留，
    // 只有刷新页面（重建 Hook 实例）才补齐。progressRef/lastSSEDataAtRef 同理需清空，
    // 避免新一轮进度被上一轮的终态快照污染或误判为「SSE 新鲜」。
    //
    // 闸门复位的同时必须作废在途轮询：复位把 completedRef 重新打开后，上一轮那次
    // 尚未返回的取数就再没有任何东西拦它——它会二次触发终态回调，把已落地的汇总
    // （生成侧三项由 generationTallyRef 供数，那时已被清空）覆盖成未知。故这里递增
    // 轮询会话代号并中止在途请求，双保险确保迟到响应被整份丢弃。
    if (prevBatchIdRef.current !== batchId) {
      prevBatchIdRef.current = batchId;
      pollRunIdRef.current += 1;
      pollAbortControllerRef.current?.abort();
      pollAbortControllerRef.current = null;
      completedRef.current = false;
      progressRef.current = null;
      lastSSEDataAtRef.current = 0;
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
