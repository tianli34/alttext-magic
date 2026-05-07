/**
 * File: app/components/dashboard/QuotaSummary.tsx
 * Purpose: 计划与配额摘要区域。
 *          Phase 4 仅放置占位 UI，待 Phase 5 接入真实数据。
 */

/**
 * 配额摘要占位组件。
 * Phase 4 阶段显示占位信息，Phase 5 将接入 /api/billing/summary 真实数据。
 */
export function QuotaSummary() {
  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
      background="subdued"
    >
      <s-stack direction="block" gap="base">
        <s-heading>计划与配额</s-heading>
        <s-text tone="neutral">
          计划与配额信息将在 Phase 5 接入，届时将展示当前套餐、已用额度与剩余额度。
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
      </s-stack>
    </s-box>
  );
}
