/**
 * File: app/components/dashboard/QuotaSummary.tsx
 * Purpose: Dashboard 当前额度内联展示。
 *          从 /api/billing/summary 获取真实数据，仅以紧凑形式显示当前额度，
 *          并提供跳转至 Billing 页面的入口。异常时静默不渲染。
 */
import { useLocation } from "react-router";
import { useBillingSummary } from "../../hooks/useBillingSummary";
import { buildAppPath } from "../../lib/app-navigation";

export function QuotaSummary() {
  const { data, loading, error } = useBillingSummary();
  const location = useLocation();

  if (loading || error || !data) {
    return null;
  }

  return (
    <s-stack direction="inline" gap="small">
      <s-text tone="neutral">当前额度：</s-text>
      <s-text>
        <strong>{data.totalRemaining}</strong>
      </s-text>
      <s-link href={buildAppPath("/app/billing", location.search)}>
        计费详情
      </s-link>
    </s-stack>
  );
}
