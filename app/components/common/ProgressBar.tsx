/**
 * File: app/components/common/ProgressBar.tsx
 * Purpose: 进度条组件，用于展示扫描进度百分比。
 */
interface ProgressBarProps {
  /** 进度百分比 0-100 */
  percent: number;
  /** 是否显示动画（扫描中） */
  animated?: boolean;
  /** 尺寸 */
  size?: "small" | "medium" | "large";
}

export function ProgressBar({
  percent,
  animated = false,
  size = "medium",
}: ProgressBarProps) {
  const heightMap = {
    small: "4px",
    medium: "8px",
    large: "12px",
  };

  const clampedPercent = Math.max(0, Math.min(100, percent));

  return (
    <s-box borderRadius="base" overflow="hidden">
      <div
        style={{
          width: "100%",
          height: heightMap[size],
          background: "var(--p-color-bg-surface-secondary, #e4e5e7)",
          borderRadius: "var(--p-border-radius-2, 4px)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${clampedPercent}%`,
            height: "100%",
            background:
              clampedPercent >= 100
                ? "var(--p-color-bg-fill-success, #2ecc71)"
                : "var(--p-color-bg-fill-primary, #008060)",
            borderRadius: "var(--p-border-radius-2, 4px)",
            transition: "width 0.5s ease-in-out",
            animation: animated ? "pulse 2s infinite" : "none",
          }}
        />
      </div>
    </s-box>
  );
}
