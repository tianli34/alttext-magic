/**
 * File: app/hooks/useQuota.ts
 * Purpose: 轻量级配额 hook，供 Dashboard 等非 Billing 页面使用。
 *          复用 useBillingSummary 但仅暴露配额相关字段。
 */
import { useBillingSummary } from './useBillingSummary';

interface QuotaData {
  /** 当前计划 */
  currentPlan: string;
  /** 总剩余额度 */
  totalRemaining: number;
  /** 包含额度剩余 */
  includedRemaining: number;
  /** 欢迎额度剩余 */
  welcomeRemaining: number;
  /** 超额包剩余 */
  overagePackRemaining: number;
}

interface UseQuotaResult {
  /** 配额数据（仅在加载完成且有数据时可用） */
  quota: QuotaData | null;
  /** 加载中 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 手动刷新 */
  refresh: () => void;
}

export function useQuota(): UseQuotaResult {
  const { data, loading, error, refresh } = useBillingSummary();

  const quota: QuotaData | null = data
    ? {
        currentPlan: data.currentPlan,
        totalRemaining: data.totalRemaining,
        includedRemaining: data.includedRemaining,
        welcomeRemaining: data.welcomeRemaining,
        overagePackRemaining: data.overagePackRemaining,
      }
    : null;

  return { quota, loading, error, refresh };
}
