/**
 * File: app/components/dashboard/GroupStatsCard.tsx
 * Purpose: 仪表盘分组统计卡片。
 *          展示单个分组（Product Media / Files / Collection / Article）
 *          的 total / hasAlt / missing / decorative 四项指标。
 */

/** 分组类型中文标签映射 */
const GROUP_TYPE_LABELS: Record<string, string> = {
  PRODUCT_MEDIA: "商品图片",
  FILES: "文件图片",
  COLLECTION: "合集图片",
  ARTICLE: "文章图片",
};

/** 分组图标映射 */
const GROUP_TYPE_ICONS: Record<string, string> = {
  PRODUCT_MEDIA: "📦",
  FILES: "📁",
  COLLECTION: "🗂️",
  ARTICLE: "📝",
};

/** 单条分组统计数据（与 DashboardGroupStats 对齐） */
export interface GroupStats {
  groupType: string;
  total: number;
  hasAlt: number;
  missing: number;
  decorative: number;
}

interface GroupStatsCardProps {
  stats: GroupStats;
}

/**
 * 分组统计卡片组件。
 *
 * 渲染一张包含以下内容的卡片：
 * - 分组图标 + 分组名称
 * - 总计数量
 * - 迷你进度条（hasAlt 占比）
 * - hasAlt / missing / decorative 三项指标
 */
export function GroupStatsCard({ stats }: GroupStatsCardProps) {
  const label = GROUP_TYPE_LABELS[stats.groupType] ?? stats.groupType;
  const icon = GROUP_TYPE_ICONS[stats.groupType] ?? "📊";
  const missingHref = `/app/candidates?group=${encodeURIComponent(
    stats.groupType,
  )}&status=PENDING`;

  // 计算 hasAlt 百分比（用于进度条）
  const hasAltPercent =
    stats.total > 0 ? Math.round((stats.hasAlt / stats.total) * 100) : 0;

  return (
    <s-box
      padding="base"
      borderRadius="base"
      borderWidth="base"
    >
      <s-stack direction="block" gap="base">
        {/* 标题行：图标 + 分组名 */}
        <s-stack direction="inline" gap="small">
          <s-text>{icon}</s-text>
          <s-heading>{label}</s-heading>
        </s-stack>

        {/* 总计数量 */}
        <s-stack direction="inline" gap="small">
          <s-text tone="neutral">总计</s-text>
          <s-text>{stats.total.toLocaleString("zh-CN")}</s-text>
        </s-stack>

        {/* 覆盖率进度条 */}
        <s-box borderRadius="base" overflow="hidden">
          <div
            style={{
              width: "100%",
              height: "6px",
              background: "var(--p-color-bg-surface-secondary, #e4e5e7)",
              borderRadius: "var(--p-border-radius-2, 4px)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${hasAltPercent}%`,
                height: "100%",
                background: "var(--p-color-bg-fill-success, #2ecc71)",
                borderRadius: "var(--p-border-radius-2, 4px)",
                transition: "width 0.5s ease-in-out",
              }}
            />
          </div>
        </s-box>

        {/* 三项指标 */}
        <s-stack direction="inline" gap="base">
          {/* 已有 Alt */}
          <s-stack direction="block" gap="small">
            <s-text tone="success">
              {stats.hasAlt.toLocaleString("zh-CN")}
            </s-text>
            <s-text tone="neutral">已有</s-text>
          </s-stack>

          {/* 缺失 */}
          <s-stack direction="block" gap="small">
            <s-link href={missingHref}>
              <s-text tone="critical">
                {stats.missing.toLocaleString("zh-CN")}
              </s-text>
            </s-link>
            <s-text tone="neutral">缺失</s-text>
          </s-stack>

          {/* 装饰性 */}
          <s-stack direction="block" gap="small">
            <s-text tone="caution">
              {stats.decorative.toLocaleString("zh-CN")}
            </s-text>
            <s-text tone="neutral">装饰性</s-text>
          </s-stack>
        </s-stack>
      </s-stack>
    </s-box>
  );
}
