/**
 * File: app/hooks/useBillingSummary.ts
 * Purpose: 获取 /api/billing/summary 数据的 hook，供 Billing 页面和 Dashboard 配额摘要使用。
 */
import { useState, useEffect, useCallback } from 'react';
import type { BillingSummaryResponse } from '../components/billing/types';

interface UseBillingSummaryResult {
  /** 计费摘要数据 */
  data: BillingSummaryResponse | null;
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 手动刷新 */
  refresh: () => void;
}

export function useBillingSummary(): UseBillingSummaryResult {
  const [data, setData] = useState<BillingSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const fetchSummary = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/billing/summary', { signal });

      if (!response.ok) {
        throw new Error(`请求失败 (${response.status})`);
      }

      const result = (await response.json()) as BillingSummaryResponse;
      setData(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      setError(
        err instanceof Error ? err.message : '加载失败，请刷新页面重试',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchSummary(controller.signal);

    return () => {
      controller.abort();
    };
  }, [fetchSummary, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  return { data, loading, error, refresh };
}
