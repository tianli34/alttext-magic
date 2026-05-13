/**
 * File: app/hooks/usePurchasePack.ts
 * Purpose: POST /api/billing/purchase-pack 的 hook。
 *          成功返回 confirmationUrl 后自动跳转 Shopify 确认页。
 */
import { useState, useCallback } from 'react';
import type { PurchasePackResponse } from '../components/billing/types';

interface UsePurchasePackResult {
  /** 请求中 */
  purchasing: boolean;
  /** 错误信息 */
  purchaseError: string | null;
  /** 发起超额包购买 */
  purchasePack: (packCode: string) => Promise<void>;
}

export function usePurchasePack(): UsePurchasePackResult {
  const [purchasing, setPurchasing] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const purchasePack = useCallback(async (packCode: string) => {
    setPurchasing(true);
    setPurchaseError(null);

    try {
      const response = await fetch('/api/billing/purchase-pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packCode }),
      });

      const result = (await response.json()) as PurchasePackResponse;

      if (!response.ok || result.error) {
        throw new Error(result.error || `请求失败 (${response.status})`);
      }

      // 跳转到 Shopify 确认页
      if (result.confirmationUrl) {
        window.top?.location.assign(result.confirmationUrl);
      }
    } catch (err) {
      setPurchaseError(
        err instanceof Error ? err.message : '购买失败，请重试',
      );
      throw err;
    } finally {
      setPurchasing(false);
    }
  }, []);

  return { purchasing, purchaseError, purchasePack };
}
