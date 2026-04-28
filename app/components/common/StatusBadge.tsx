/**
 * File: app/components/common/StatusBadge.tsx
 * Purpose: 状态徽章组件，用于显示 task/job 级别状态。
 */

interface StatusBadgeProps {
  /** 状态值 */
  status: string;
  /** 显示标签（可选，默认使用 status） */
  label?: string;
}

/** 状态到显示配置的映射 */
const STATUS_CONFIG: Record<
  string,
  { label: string; tone: "info" | "success" | "critical" | "caution" | "neutral" }
> = {
  PENDING: { label: "等待中", tone: "neutral" },
  RUNNING: { label: "进行中", tone: "info" },
  SUCCESS: { label: "成功", tone: "success" },
  FAILED: { label: "失败", tone: "critical" },
  PARTIAL_SUCCESS: { label: "部分成功", tone: "caution" },
  PARSING: { label: "解析中", tone: "info" },
  READY_TO_PARSE: { label: "待解析", tone: "neutral" },
  NOT_PUBLISHED: { label: "未发布", tone: "neutral" },
  PUBLISHED: { label: "已发布", tone: "success" },
};

export function StatusBadge({ status, label }: StatusBadgeProps) {
  const config = STATUS_CONFIG[status] ?? { label: status, tone: "neutral" as const };
  const displayLabel = label ?? config.label;

  const toneColorMap: Record<string, string> = {
    info: "var(--p-color-bg-fill-info, #00a3e0)",
    success: "var(--p-color-bg-fill-success, #2ecc71)",
    critical: "var(--p-color-bg-fill-critical, #e74c3c)",
    caution: "var(--p-color-bg-fill-caution, #f1c40f)",
    neutral: "var(--p-color-bg-surface-secondary, #999)",
  };

  return (
    <s-box
      padding="small"
      borderRadius="base"
      borderWidth="base"
      background="subdued"
    >
      <s-text tone={config.tone}>{displayLabel}</s-text>
    </s-box>
  );
}
