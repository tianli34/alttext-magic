/**
 * File: app/components/billing/QuotaBreakdown.tsx
 * Purpose: 当前计划与配额余额展示组件。
 */
import type { BillingSummaryResponse } from './types';

interface QuotaBreakdownProps {
  /** 计费摘要数据 */
  data: BillingSummaryResponse;
}

/** 余额行组件 */
function BalanceRow({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <s-stack direction="inline" gap="base">
      <span style={{ flex: 1, color: 'var(--p-color-text-secondary, #6d7175)' }}>
        {label}
      </span>
      <span
        style={{
          fontWeight: 600,
          color:
            tone === 'success'
              ? 'var(--p-color-bg-fill-success, #2ecc71)'
              : tone === 'warning'
                ? 'var(--p-color-text-warning, #ff9800)'
                : 'var(--p-color-text-primary, #202223)',
        }}
      >
        {value}
      </span>
    </s-stack>
  );
}

export function QuotaBreakdown({ data }: QuotaBreakdownProps) {
  const planDisplayName =
    data.plans.find((p) => p.planKey === data.currentPlan)?.displayName ??
    data.currentPlan;

  const intervalLabel = data.billingInterval === 'ANNUAL' ? '年付' : '月付';

  // 计算总额度百分比
  const planConfig = data.plans.find((p) => p.planKey === data.currentPlan);
  const totalQuota = planConfig
    ? data.billingInterval === 'ANNUAL'
      ? planConfig.annualTotalCredits
      : planConfig.monthlyQuota
    : 0;
  const usedPercent =
    totalQuota > 0
      ? Math.round(((totalQuota - data.includedRemaining) / totalQuota) * 100)
      : 0;

  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
      background="subdued"
    >
      <s-stack direction="block" gap="base">
        {/* 当前计划标题 */}
        <s-stack direction="inline" gap="base">
          <s-heading>当前计划</s-heading>
          <span
            style={{
              display: 'inline-block',
              padding: '2px 8px',
              borderRadius: '4px',
              background: 'var(--p-color-bg-fill-brand, #008060)',
              color: 'var(--p-color-text-brand-on-bg-fill, #ffffff)',
              fontSize: '0.875rem',
              fontWeight: 600,
            }}
          >
            {planDisplayName}
          </span>
          <s-text tone="neutral">{intervalLabel}</s-text>
        </s-stack>

        {/* 进度条 */}
        {totalQuota > 0 && (
          <s-stack direction="block" gap="small">
            <s-text tone="neutral">
              已使用 {usedPercent}%（{totalQuota - data.includedRemaining} / {totalQuota}）
            </s-text>
            <div
              style={{
                width: '100%',
                height: '8px',
                background: 'var(--p-color-bg-surface-secondary, #e4e5e7)',
                borderRadius: '4px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${usedPercent}%`,
                  height: '100%',
                  background:
                    usedPercent >= 90
                      ? 'var(--p-color-bg-fill-critical, #d72c0d)'
                      : usedPercent >= 70
                        ? 'var(--p-color-text-warning, #ff9800)'
                        : 'var(--p-color-bg-fill-primary, #008060)',
                  borderRadius: '4px',
                  transition: 'width 0.5s ease-in-out',
                }}
              />
            </div>
          </s-stack>
        )}

        {/* 余额明细 */}
        <s-stack direction="block" gap="small">
          <BalanceRow
            label={`包含额度剩余（${data.includedPeriodType}）`}
            value={data.includedRemaining}
          />
          {data.welcomeRemaining > 0 && (
            <BalanceRow label="欢迎额度剩余" value={data.welcomeRemaining} tone="success" />
          )}
          {data.overagePackRemaining > 0 && (
            <BalanceRow label="超额包剩余" value={data.overagePackRemaining} tone="warning" />
          )}
          <div
            style={{
              borderTop: '1px solid var(--p-color-border-secondary, #c9cccf)',
              paddingTop: '8px',
              marginTop: '4px',
            }}
          >
            <BalanceRow label="总剩余额度" value={data.totalRemaining} tone="success" />
          </div>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
