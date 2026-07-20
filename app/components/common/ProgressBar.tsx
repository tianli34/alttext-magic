/**
 * File: app/components/common/ProgressBar.tsx
 * Purpose: 进度条组件，用于展示扫描进度百分比。
 *          支持 indeterminate 不确定进度模式（发现阶段：无限滑动动画，
 *          忽略 percent），用于「已发现 N 个对象…」这类未知总量的阶段。
 */
interface ProgressBarProps {
  /** 进度百分比 0-100（indeterminate 为 true 时忽略） */
  percent: number;
  /** 是否显示动画（扫描中） */
  animated?: boolean;
  /** 尺寸 */
  size?: "small" | "medium" | "large";
  /** 不确定进度模式：渲染无限滑动动画，用于总量未知的发现阶段 */
  indeterminate?: boolean;
}

const HEIGHT_MAP = {
  small: "4px",
  medium: "8px",
  large: "12px",
} as const;

/** 不确定进度滑块动画的 keyframes（组件自带，避免依赖全局样式）。 */
const INDETERMINATE_KEYFRAMES = `
@keyframes alttext-progress-indeterminate {
  0% { left: -35%; }
  100% { left: 100%; }
}`;

export function ProgressBar({
  percent,
  animated = false,
  size = "medium",
  indeterminate = false,
}: ProgressBarProps) {
  const height = HEIGHT_MAP[size];

  if (indeterminate) {
    return (
      <s-box borderRadius="base" overflow="hidden">
        <style>{INDETERMINATE_KEYFRAMES}</style>
        <div
          style={{
            position: "relative",
            width: "100%",
            height,
            background: "var(--p-color-bg-surface-secondary, #e4e5e7)",
            borderRadius: "var(--p-border-radius-2, 4px)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 0,
              left: "-35%",
              width: "35%",
              height: "100%",
              background: "var(--p-color-bg-fill-primary, #008060)",
              borderRadius: "var(--p-border-radius-2, 4px)",
              animation:
                "alttext-progress-indeterminate 1.4s ease-in-out infinite",
            }}
          />
        </div>
      </s-box>
    );
  }

  const clampedPercent = Math.max(0, Math.min(100, percent));

  return (
    <s-box borderRadius="base" overflow="hidden">
      <div
        style={{
          width: "100%",
          height,
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
