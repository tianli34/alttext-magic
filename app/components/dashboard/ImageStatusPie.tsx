/**
 * File: app/components/dashboard/ImageStatusPie.tsx
 * Purpose: 仪表盘图片状态分布饼状图。
 *          汇总所有分组的 4 类图片数据：
 *            - PENDING（待生成）
 *            - WRITEBACK_PENDING（待写回）
 *            - HAS_ALT（已有 Alt）
 *            - DECORATIVE_SKIPPED（装饰性跳过）
 *          以纯 SVG 饼状图展示各自占比，取代原分组统计卡片。
 *          不依赖任何图表库，完全自包含。
 */

import { useMemo } from "react";

/** 单分组统计（与 GET /api/dashboard 的 groups 元素字段对齐） */
export interface ImageGroupStats {
  groupType: string;
  total: number;
  hasAlt: number;
  altGap: number;
  decorative: number;
  pending: number;
  generated: number;
}

/** 4 类状态元信息（数组顺序即图例与扇区顺序） */
const STATUS_META = [
  { key: "PENDING", label: "待生成", color: "#ffc453" },
  { key: "WRITEBACK_PENDING", label: "待写回", color: "#2c6ecb" },
  { key: "HAS_ALT", label: "已有 Alt", color: "#50b83c" },
  { key: "DECORATIVE_SKIPPED", label: "装饰性跳过", color: "#919eab" },
] as const;

type StatusKey = (typeof STATUS_META)[number]["key"];

interface ImageStatusPieProps {
  /** 各分组统计数据（来自 GET /api/dashboard） */
  groups: ImageGroupStats[];
}

/* ---------------------------------------------------------------- */
/*  SVG 饼图几何计算                                                  */
/* ---------------------------------------------------------------- */

const PIE_SIZE = 400;
const PIE_CENTER = PIE_SIZE / 2;
const PIE_RADIUS = 160;

/** 将比例（0~1）映射为圆上坐标，0 从 12 点方向开始顺时针 */
function pointOnCircle(
  cx: number,
  cy: number,
  r: number,
  fraction: number,
): { x: number; y: number } {
  const angle = fraction * 2 * Math.PI - Math.PI / 2;
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
}

/** 生成单个扇区的 path 数据 */
function buildSlicePath(
  cx: number,
  cy: number,
  r: number,
  startFraction: number,
  endFraction: number,
): string {
  const start = pointOnCircle(cx, cy, r, startFraction);
  const end = pointOnCircle(cx, cy, r, endFraction);
  const largeArc = endFraction - startFraction > 0.5 ? 1 : 0;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`,
    "Z",
  ].join(" ");
}

/* ---------------------------------------------------------------- */
/*  饼状图组件                                                        */
/* ---------------------------------------------------------------- */

export function ImageStatusPie({ groups }: ImageStatusPieProps) {
  // 汇总 4 类数量
  const totals = useMemo(() => {
    const acc: Record<StatusKey, number> = {
      PENDING: 0,
      WRITEBACK_PENDING: 0,
      HAS_ALT: 0,
      DECORATIVE_SKIPPED: 0,
    };
    for (const g of groups) {
      acc.PENDING += g.pending;
      acc.WRITEBACK_PENDING += g.generated;
      acc.HAS_ALT += g.hasAlt;
      acc.DECORATIVE_SKIPPED += g.decorative;
    }
    return acc;
  }, [groups]);

  const total =
    totals.PENDING + totals.WRITEBACK_PENDING + totals.HAS_ALT + totals.DECORATIVE_SKIPPED;

  // 无数据兜底
  if (total === 0) {
    return (
      <s-box
        padding="base"
        borderRadius="base"
        background="subdued"
        borderWidth="base"
      >
        <s-stack direction="block" gap="small">
          <s-heading>图片状态分布</s-heading>
          <s-text tone="neutral">
            暂无统计数据。请完成首次扫描后查看仪表盘。
          </s-text>
        </s-stack>
      </s-box>
    );
  }

  // 计算每个扇区的占比与 path
  const slices = STATUS_META.map((meta) => {
    const value = totals[meta.key];
    return { ...meta, value, fraction: value / total };
  });

  // 仅有一个非空分类时（占满 100%），用整圆绘制，避免单扇区 path 退化
  const nonZero = slices.filter((s) => s.value > 0);

  let cumulative = 0;
  const paths = slices.map((slice) => {
    const startFraction = cumulative;
    cumulative += slice.fraction;
    const endFraction = cumulative;
    return {
      ...slice,
      path: buildSlicePath(
        PIE_CENTER,
        PIE_CENTER,
        PIE_RADIUS,
        startFraction,
        endFraction,
      ),
    };
  });

  // 无障碍摘要文本
  const summary = slices
    .map((s) => `${s.label} ${Math.round(s.fraction * 100)}%`)
    .join("，");

  return (
    <s-box padding="base" borderRadius="base" borderWidth="base">
      <s-stack direction="block" gap="base">
        <s-heading>图片状态分布</s-heading>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "1.5rem",
            alignItems: "center",
          }}
        >
          {/* 饼状图 */}
          <svg
            width={PIE_SIZE}
            height={PIE_SIZE}
            viewBox={`0 0 ${PIE_SIZE} ${PIE_SIZE}`}
            role="img"
            aria-label={`图片状态分布饼状图：${summary}。共 ${total.toLocaleString(
              "zh-CN",
            )} 张。`}
          >
            {nonZero.length === 1 ? (
              <circle
                cx={PIE_CENTER}
                cy={PIE_CENTER}
                r={PIE_RADIUS}
                fill={nonZero[0].color}
              >
                <title>
                  {`${nonZero[0].label}：${nonZero[0].value.toLocaleString(
                    "zh-CN",
                  )} 张（100%）`}
                </title>
              </circle>
            ) : (
              paths.map((p) => (
                <path
                  key={p.key}
                  d={p.path}
                  fill={p.color}
                  stroke="var(--p-color-bg-surface, #ffffff)"
                  strokeWidth={1.5}
                >
                  <title>
                    {`${p.label}：${p.value.toLocaleString("zh-CN")} 张（${Math.round(
                      p.fraction * 100,
                    )}%）`}
                  </title>
                </path>
              ))
            )}
          </svg>

          {/* 图例 */}
          <s-stack direction="block" gap="small">
            {paths.map((p) => (
              <s-stack key={p.key} direction="inline" gap="small">
                <span
                  aria-hidden="true"
                  style={{
                    display: "inline-block",
                    width: "0.75rem",
                    height: "0.75rem",
                    borderRadius: "2px",
                    background: p.color,
                    flexShrink: 0,
                  }}
                />
                <s-text>{p.label}</s-text>
                <s-text tone="neutral">
                  {p.value.toLocaleString("zh-CN")}（
                  {Math.round(p.fraction * 100)}%）
                </s-text>
              </s-stack>
            ))}
            <s-stack direction="inline" gap="small">
              <s-text tone="neutral">总计</s-text>
              <s-text>{total.toLocaleString("zh-CN")}</s-text>
            </s-stack>
          </s-stack>
        </div>
      </s-stack>
    </s-box>
  );
}
