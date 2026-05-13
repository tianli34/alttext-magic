/**
 * File: app/components/dashboard/QuotaSummary.tsx
 * Purpose: Dashboard 配额摘要卡片。
 *          从 /api/billing/summary 获取真实数据，展示当前计划与各分组余额。
 *          异常时降级为占位 UI，不影响 Dashboard 主功能。
 */
import { useNavigate } from "react-router";
import { useBillingSummary } from "../../hooks/useBillingSummary";

/* ------------------------------------------------------------------ */
/*  余额行组件                                                          */
/* ------------------------------------------------------------------ */

interface BalanceRowProps {
  /** 标签 */
  label: string;
  /** 数值 */
  value: number;
  /** 语义色调 */
  tone?: "success" | "warning" | "neutral";
}

function BalanceRow({ label, value, tone }: BalanceRowProps) {
  const colorMap: Record<string, string> = {
    success: "var(--p-color-bg-fill-success, #2ecc71)",
    warning: "var(--p-color-text-warning, #ff9800)",
    neutral: "var(--p-color-text-secondary, #6d7175)",
  };

  return (
    <s-stack direction="inline" gap="base">
      <span style={{ flex: 1, color: "var(--p-color-text-secondary, #6d7175)" }}>
        {label}
      </span>
      <span
        style={{
          fontWeight: 600,
          color: colorMap[tone ?? ""] ?? "var(--p-color-text-primary, #202223)",
        }}
      >
        {value}
      </span>
    </s-stack>
  );
}

/* ------------------------------------------------------------------ */
/*  降级占位骨架                                                         */
/* ------------------------------------------------------------------ */

function QuotaSummaryFallback({ message }: { message?: string }) {
  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
      background="subdued"
    >
      <s-stack direction="block" gap="base">
        <s-heading>计划与配额</s-heading>
        {message ? (
          <s-text tone="neutral">{message}</s-text>
        ) : (
          <>
            <s-text tone="neutral">
              计划与配额信息暂时无法加载，您可以前往计费页面查看。
            </s-text>
            {/* 占位骨架 */}
            <s-stack direction="inline" gap="base">
              <div style={{ flex: "1" }}>
                <s-box
                  padding="base"
                  borderRadius="base"
                  borderWidth="base"
                >
                  <s-stack direction="block" gap="small">
                    <s-text tone="neutral">当前计划</s-text>
                    <s-text>—</s-text>
                  </s-stack>
                </s-box>
              </div>
              <div style={{ flex: "1" }}>
                <s-box
                  padding="base"
                  borderRadius="base"
                  borderWidth="base"
                >
                  <s-stack direction="block" gap="small">
                    <s-text tone="neutral">剩余额度</s-text>
                    <s-text>—</s-text>
                  </s-stack>
                </s-box>
              </div>
            </s-stack>
          </>
        )}
      </s-stack>
    </s-box>
  );
}

/* ------------------------------------------------------------------ */
/*  主组件                                                              */
/* ------------------------------------------------------------------ */

export function QuotaSummary() {
  const { data, loading, error } = useBillingSummary();
  const navigate = useNavigate();

  /* ---- 加载中 → 显示骨架占位 ---- */
  if (loading) {
    return <QuotaSummaryFallback message="正在加载配额信息…" />;
  }

  /* ---- 错误 → 降级占位，不影响 Dashboard ---- */
  if (error || !data) {
    return <QuotaSummaryFallback />;
  }

  /* ---- 正常数据渲染 ---- */
  const planDisplayName =
    data.plans.find((p) => p.planKey === data.currentPlan)?.displayName ??
    data.currentPlan;

  const intervalLabel = data.billingInterval === "ANNUAL" ? "年付" : "月付";

  // 总余额色调：> 0 绿色, = 0 警告
  const totalTone =
    data.totalRemaining > 0
      ? "success" as const
      : ("warning" as const);

  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
      background="subdued"
    >
      <s-stack direction="block" gap="base">
        {/* 标题行 */}
        <s-stack direction="inline" gap="base">
          <s-heading>计划与配额</s-heading>
          <span
            style={{
              display: "inline-block",
              padding: "2px 8px",
              borderRadius: "4px",
              background: "var(--p-color-bg-fill-brand, #008060)",
              color: "var(--p-color-text-brand-on-bg-fill, #ffffff)",
              fontSize: "0.875rem",
              fontWeight: 600,
            }}
          >
            {planDisplayName}
          </span>
          <s-text tone="neutral">{intervalLabel}</s-text>
        </s-stack>

        {/* 余额分组卡片 */}
        <s-stack direction="inline" gap="base">
          {/* 总剩余额度 */}
          <div style={{ flex: "1" }}>
            <s-box
              padding="base"
              borderRadius="base"
              borderWidth="base"
            >
              <s-stack direction="block" gap="small">
                <s-text tone="neutral">总剩余额度</s-text>
                <BalanceRow label="" value={data.totalRemaining} tone={totalTone} />
              </s-stack>
            </s-box>
          </div>

          {/* Included 余额 */}
          <div style={{ flex: "1" }}>
            <s-box
              padding="base"
              borderRadius="base"
              borderWidth="base"
            >
              <s-stack direction="block" gap="small">
                <s-text tone="neutral">订阅额度</s-text>
                <BalanceRow label="" value={data.includedRemaining} />
              </s-stack>
            </s-box>
          </div>

          {/* Welcome 余额 */}
          <div style={{ flex: "1" }}>
            <s-box
              padding="base"
              borderRadius="base"
              borderWidth="base"
            >
              <s-stack direction="block" gap="small">
                <s-text tone="neutral">欢迎额度</s-text>
                <BalanceRow label="" value={data.welcomeRemaining} />
              </s-stack>
            </s-box>
          </div>

          {/* Overage Pack 余额 */}
          <div style={{ flex: "1" }}>
            <s-box
              padding="base"
              borderRadius="base"
              borderWidth="base"
            >
              <s-stack direction="block" gap="small">
                <s-text tone="neutral">超额包</s-text>
                <BalanceRow label="" value={data.overagePackRemaining} />
              </s-stack>
            </s-box>
          </div>
        </s-stack>

        {/* 跳转 Billing 页面入口 */}
        <div
          onClick={() => navigate("/app/billing")}
          style={{ display: "inline-block", cursor: "pointer" }}
        >
          <s-button variant="secondary" accessibilityLabel="查看计费详情">
            查看计费详情
          </s-button>
        </div>
      </s-stack>
    </s-box>
  );
}
