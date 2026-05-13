/**
 * File: app/components/billing/PlanCard.tsx
 * Purpose: 单个计划卡片组件，展示计划名称、价格、额度与操作按钮。
 */
import type { PlanKey, BillingInterval, PlanSummary } from './types';

interface PlanCardProps {
  /** 计划配置 */
  plan: PlanSummary;
  /** 当前选中的计费周期 */
  interval: BillingInterval;
  /** 是否为当前计划 */
  isCurrentPlan: boolean;
  /** 点击升级/切换/降级 */
  onAction: (planKey: PlanKey, interval: BillingInterval) => void;
  /** 按钮禁用（请求中） */
  actionDisabled?: boolean;
  /** 当前计划（用于判断升级/降级） */
  currentPlan?: PlanKey | null;
}

/** 格式化美分价格为美元字符串 */
function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return `$${(cents / 100).toFixed(2)}`;
}

/** 获取额度描述 */
function getQuotaLabel(plan: PlanSummary, interval: BillingInterval): string {
  if (plan.planKey === 'FREE') {
    return `${plan.monthlyQuota} 次/月`;
  }
  if (interval === 'ANNUAL') {
    return `${plan.annualTotalCredits.toLocaleString()} 次/年`;
  }
  return `${plan.monthlyQuota} 次/月`;
}

/** 获取按钮文案 */
function getButtonLabel(
  planKey: PlanKey,
  isCurrentPlan: boolean,
  currentPlan: PlanKey | null,
): string {
  if (isCurrentPlan) return '当前计划';

  const planOrder: PlanKey[] = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'MAX'];
  if (currentPlan) {
    const currentIdx = planOrder.indexOf(currentPlan);
    const targetIdx = planOrder.indexOf(planKey);
    if (targetIdx < currentIdx) return '降级';
  }

  if (planKey === 'FREE') return '降级到 Free';
  return '升级';
}

export function PlanCard({
  plan,
  interval,
  isCurrentPlan,
  onAction,
  actionDisabled = false,
  currentPlan,
}: PlanCardProps) {
  const price =
    plan.planKey === 'FREE'
      ? 0
      : interval === 'ANNUAL'
        ? plan.annualMonthlyPriceCents
        : plan.monthlyPriceCents;

  const priceLabel = formatPrice(price);
  const periodLabel =
    plan.planKey === 'FREE'
      ? ''
      : interval === 'ANNUAL'
        ? '/月（年付）'
        : '/月';
  const quotaLabel = getQuotaLabel(plan, interval);
  const buttonLabel = getButtonLabel(
    plan.planKey,
    isCurrentPlan,
    currentPlan ?? null,
  );

  const isHighlighted = plan.planKey === 'GROWTH';

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        border: isHighlighted
          ? '2px solid var(--p-color-bg-fill-brand, #008060)'
          : isCurrentPlan
            ? '2px solid var(--p-color-border-brand, #008060)'
            : '1px solid var(--p-color-border-secondary, #c9cccf)',
        borderRadius: '0.75rem',
        padding: '16px',
      }}
    >
      {/* 推荐标签 */}
      {isHighlighted && !isCurrentPlan && (
        <div
          style={{
            position: 'absolute',
            top: '-10px',
            right: '12px',
            background: 'var(--p-color-bg-fill-brand, #008060)',
            color: 'var(--p-color-text-brand-on-bg-fill, #ffffff)',
            fontSize: '0.75rem',
            fontWeight: 600,
            padding: '2px 8px',
            borderRadius: '4px',
          }}
        >
          推荐
        </div>
      )}

      {/* 计划名称 */}
      <s-heading>{plan.displayName}</s-heading>

      {/* 价格 */}
      <s-stack direction="block" gap="small">
        <s-stack direction="inline" gap="small">
          <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            {priceLabel}
          </span>
          {periodLabel && (
            <span
              style={{
                color: 'var(--p-color-text-secondary, #6d7175)',
              }}
            >
              {periodLabel}
            </span>
          )}
        </s-stack>
        {interval === 'ANNUAL' && plan.planKey !== 'FREE' && (
          <s-text tone="neutral">
            年付总价 {formatPrice(plan.annualMonthlyPriceCents * 12)}
          </s-text>
        )}
      </s-stack>

      {/* 额度 */}
      <s-stack direction="block" gap="small">
        <s-text>{quotaLabel}</s-text>
        {plan.incrementalScanEnabled && (
          <s-text tone="neutral">✓ 自动增量扫描</s-text>
        )}
      </s-stack>

      {/* 操作按钮 */}
      <div style={{ marginTop: 'auto' }}>
        {isCurrentPlan ? (
          <button
            type="button"
            disabled
            style={{
              display: 'block',
              width: '100%',
              padding: '0.5rem 1rem',
              border: '1px solid var(--p-color-border-brand, #008060)',
              borderRadius: '0.5rem',
              background: 'transparent',
              color: 'var(--p-color-text-brand, #008060)',
              font: 'inherit',
              fontWeight: 600,
              cursor: 'default',
            }}
          >
            {buttonLabel}
          </button>
        ) : (
          <button
            type="button"
            disabled={actionDisabled}
            onClick={() => onAction(plan.planKey, interval)}
            style={{
              display: 'block',
              width: '100%',
              padding: '0.5rem 1rem',
              border: 'none',
              borderRadius: '0.5rem',
              background: 'var(--p-color-bg-fill-brand, #008060)',
              color: 'var(--p-color-text-brand-on-bg-fill, #ffffff)',
              font: 'inherit',
              fontWeight: 600,
              cursor: actionDisabled ? 'not-allowed' : 'pointer',
              opacity: actionDisabled ? 0.6 : 1,
            }}
          >
            {buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}
