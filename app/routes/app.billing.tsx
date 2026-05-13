/**
 * File: app/routes/app.billing.tsx
 * Purpose: Billing 计费页面 —— 展示当前计划、余额、计划选择、超额包购买和购买记录。
 */
import { useState, useCallback } from 'react';
import { useBillingSummary } from '../hooks/useBillingSummary';
import { useChangePlan } from '../hooks/useChangePlan';
import { usePurchasePack } from '../hooks/usePurchasePack';
import { QuotaBreakdown } from '../components/billing/QuotaBreakdown';
import { BillingIntervalToggle } from '../components/billing/BillingIntervalToggle';
import { PlanCard } from '../components/billing/PlanCard';
import { OveragePackCard } from '../components/billing/OveragePackCard';
import planGridStyles from '../components/billing/BillingGrid.module.css';
import type { BillingInterval, PlanKey } from '../components/billing/types';

/* ------------------------------------------------------------------ */
/*  日期格式化                                                          */
/* ------------------------------------------------------------------ */

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

/* ------------------------------------------------------------------ */
/*  主组件                                                              */
/* ------------------------------------------------------------------ */

export default function AppBillingPage() {
  const { data, loading, error, refresh } = useBillingSummary();
  const { changing, changeError, changePlan } = useChangePlan();
  const { purchasing, purchaseError, purchasePack } = usePurchasePack();

  // 月付/年付展示切换（默认使用当前实际的计费周期）
  const [displayInterval, setDisplayInterval] = useState<BillingInterval>(
    data?.billingInterval ?? 'MONTHLY',
  );

  // 当数据加载后，同步 displayInterval
  const handleIntervalChange = useCallback(
    (interval: BillingInterval) => {
      setDisplayInterval(interval);
    },
    [],
  );

  // 计划变更处理
  const handlePlanAction = useCallback(
    async (planKey: PlanKey, interval: BillingInterval) => {
      try {
        await changePlan(planKey, interval);
        // Free 降级成功后刷新数据
        if (planKey === 'FREE') {
          refresh();
        }
      } catch {
        // 错误已在 hook 中处理
      }
    },
    [changePlan, refresh],
  );

  // 超额包购买处理
  const handlePurchasePack = useCallback(
    async (packCode: string) => {
      try {
        await purchasePack(packCode);
      } catch {
        // 错误已在 hook 中处理
      }
    },
    [purchasePack],
  );

  /* ---------------------------------------------------------------- */
  /*  Loading 状态                                                      */
  /* ---------------------------------------------------------------- */
  if (loading && !data) {
    return (
      <s-page heading="Billing">
        <s-section heading="加载中">
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
          >
            <s-stack direction="block" gap="base">
              <s-text>正在加载计费信息…</s-text>
              {/* 骨架占位 */}
              <div
                style={{
                  height: '120px',
                  background:
                    'var(--p-color-bg-surface-secondary, #e4e5e7)',
                  borderRadius: '8px',
                }}
              />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(5, 1fr)',
                  gap: '16px',
                }}
              >
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      height: '200px',
                      background:
                        'var(--p-color-bg-surface-secondary, #e4e5e7)',
                      borderRadius: '8px',
                    }}
                  />
                ))}
              </div>
            </s-stack>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  Error 状态                                                        */
  /* ---------------------------------------------------------------- */
  if (error && !data) {
    return (
      <s-page heading="Billing">
        <s-section heading="加载失败">
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
          >
            <s-stack direction="block" gap="base">
              <s-text tone="caution">{error}</s-text>
              <button
                type="button"
                onClick={refresh}
                style={{
                  display: 'inline-block',
                  padding: '0.5rem 1rem',
                  border: 'none',
                  borderRadius: '0.5rem',
                  background:
                    'var(--p-color-bg-fill-brand, #008060)',
                  color: 'var(--p-color-text-brand-on-bg-fill, #ffffff)',
                  font: 'inherit',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                重试
              </button>
            </s-stack>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  空状态（无数据但无错误）                                            */
  /* ---------------------------------------------------------------- */
  if (!data) {
    return (
      <s-page heading="Billing">
        <s-section heading="暂无数据">
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
          >
            <s-text tone="neutral">
              暂无计费信息，请稍后再试。
            </s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  /* ---------------------------------------------------------------- */
  /*  正常渲染                                                          */
  /* ---------------------------------------------------------------- */
  return (
    <s-page heading="Billing">
      {/* 全局错误提示 */}
      {(changeError || purchaseError) && (
        <s-section>
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
          >
            <s-text tone="caution">
              {changeError || purchaseError}
            </s-text>
          </s-box>
        </s-section>
      )}

      {/* 1. 当前计划与配额 */}
      <s-section heading="当前计划与配额">
        <QuotaBreakdown data={data} />
      </s-section>

      {/* 2. 计划选择 */}
      <s-section heading="选择计划">
        <BillingIntervalToggle
          value={displayInterval}
          onChange={handleIntervalChange}
          disabled={changing}
        />

        <div className={planGridStyles.planGrid}>
          {data.plans.map((plan) => (
            <PlanCard
              key={plan.planKey}
              plan={plan}
              interval={displayInterval}
              isCurrentPlan={plan.planKey === data.currentPlan}
              currentPlan={data.currentPlan}
              onAction={handlePlanAction}
              actionDisabled={changing}
            />
          ))}
        </div>
      </s-section>

      {/* 3. 超额包购买 */}
      <s-section heading="超额包">
        <OveragePackCard
          packs={data.overagePacks}
          onPurchase={handlePurchasePack}
          disabled={purchasing}
        />
      </s-section>

      {/* 4. 最近购买记录 */}
      <s-section heading="购买记录">
        {data.recentPurchases.length === 0 ? (
          <s-box
            padding="base"
            borderRadius="base"
            borderWidth="base"
            background="subdued"
          >
            <s-text tone="neutral">暂无购买记录。</s-text>
          </s-box>
        ) : (
          <div
            style={{
              border: '1px solid var(--p-color-border-secondary, #c9cccf)',
              borderRadius: '0.75rem',
              overflow: 'hidden',
            }}
          >
            {/* 表头 */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr 1fr 2fr',
                gap: '8px',
                padding: '12px 16px',
                background:
                  'var(--p-color-bg-surface-secondary, #f6f6f7)',
                borderBottom:
                  '1px solid var(--p-color-border-secondary, #c9cccf)',
                fontWeight: 600,
                fontSize: '0.875rem',
                color: 'var(--p-color-text-secondary, #6d7175)',
              }}
            >
              <span>超额包</span>
              <span>额度</span>
              <span>价格</span>
              <span>时间</span>
            </div>

            {/* 数据行 */}
            {data.recentPurchases.map((purchase, idx) => (
              <div
                key={`${purchase.packKey}-${purchase.createdAt}-${idx}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr 2fr',
                  gap: '8px',
                  padding: '12px 16px',
                  borderBottom:
                    idx < data.recentPurchases.length - 1
                      ? '1px solid var(--p-color-border-secondary, #c9cccf)'
                      : 'none',
                }}
              >
                <span>{purchase.packKey}</span>
                <span>{purchase.amount}</span>
                <span>${purchase.price.toFixed(2)}</span>
                <span style={{ color: 'var(--p-color-text-secondary, #6d7175)' }}>
                  {formatDate(purchase.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}
