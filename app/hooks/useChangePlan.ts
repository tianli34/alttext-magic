/**
 * File: app/hooks/useChangePlan.ts
 * Purpose: POST /api/billing/change-plan 的 hook。
 *          成功返回 confirmationUrl 后自动跳转 Shopify 确认页。
 */
import { useState, useCallback } from 'react';
import type { PlanKey, BillingInterval, ChangePlanResponse } from '../components/billing/types';

interface UseChangePlanResult {
  /** 请求中 */
  changing: boolean;
  /** 错误信息 */
  changeError: string | null;
  /** 发起计划变更 */
  changePlan: (plan: PlanKey, interval: BillingInterval) => Promise<void>;
}

export function useChangePlan(): UseChangePlanResult {
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<string | null>(null);

  const changePlan = useCallback(async (plan: PlanKey, interval: BillingInterval) => {
    setChanging(true);
    setChangeError(null);

    try {
      const response = await fetch('/api/billing/change-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, interval }),
      });

      const result = (await response.json()) as ChangePlanResponse;

      if (!response.ok || result.error) {
        throw new Error(result.error || `请求失败 (${response.status})`);
      }

      // 付费计划：跳转到 Shopify 确认页
      if (result.confirmationUrl) {
        window.top?.location.assign(result.confirmationUrl);
        return;
      }

      // Free 降级：不需要跳转，由调用方决定是否刷新
    } catch (err) {
      setChangeError(
        err instanceof Error ? err.message : '计划变更失败，请重试',
      );
      throw err;
    } finally {
      setChanging(false);
    }
  }, []);

  return { changing, changeError, changePlan };
}
