/**
 * File: app/components/onboarding/ScanNotice.tsx
 * Purpose: 首次扫描说明页的说明内容展示组件。
 *          展示扫描范围、用途说明、留存期限、AI 使用边界四块信息。
 *          内容来源：docs/首次扫描前说明.md
 */

export interface ScanNoticeProps {
  /** 用户是否已勾选确认阅读 */
  acknowledged: boolean;
  /** 确认状态变更回调 */
  onAcknowledgeChange: (acknowledged: boolean) => void;
}

export function ScanNotice({
  acknowledged,
  onAcknowledgeChange,
}: ScanNoticeProps) {
  return (
    <s-stack direction="block" gap="base">
      {/* ===== 扫描范围 ===== */}
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        <s-stack direction="block" gap="small">
          <s-heading>扫描范围</s-heading>
          <s-paragraph>
            本次扫描将覆盖您店铺中以下四类图片资源：
          </s-paragraph>
          <s-box padding="small" borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.5rem", borderBottom: "1px solid var(--p-color-border)" }}>图片类型</th>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.5rem", borderBottom: "1px solid var(--p-color-border)" }}>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>产品媒体</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>产品页面的所有图片与媒体文件</td>
                </tr>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>文件库图片</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>店铺文件库中上传的通用素材与营销图</td>
                </tr>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>集合封面图</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>各集合的横幅与封面图片</td>
                </tr>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>文章封面图</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>博客文章的封面图片</td>
                </tr>
              </tbody>
            </table>
          </s-box>
          <s-box padding="small" background="base" borderRadius="base">
            <s-text>
              富文本正文中内嵌的图片<strong>不在</strong>本次扫描范围内，不会被读取或处理。
            </s-text>
          </s-box>
        </s-stack>
      </s-box>

      {/* ===== 用途说明 ===== */}
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        <s-stack direction="block" gap="small">
          <s-heading>用途说明</s-heading>
          <s-paragraph>扫描结果将用于以下目的：</s-paragraph>
          <s-stack direction="block" gap="small">
            <s-text>
              • <strong>识别缺失 Alt Text 的图片</strong>，统计各类型图片的补齐情况
            </s-text>
            <s-text>
              • <strong>生成仪表盘视图</strong>，帮助您直观了解哪些图片需要优先处理
            </s-text>
            <s-text>
              • <strong>为后续 AI 生成与写回操作提供数据基础</strong>
            </s-text>
          </s-stack>
          <s-box padding="small" background="base" borderRadius="base">
            <s-text>
              扫描结果不会用于任何广告、分析或第三方商业目的。
            </s-text>
          </s-box>
        </s-stack>
      </s-box>

      {/* ===== 留存期限 ===== */}
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        <s-stack direction="block" gap="small">
          <s-heading>留存期限</s-heading>
          <s-paragraph>不同类型的数据，留存规则如下：</s-paragraph>
          <s-box padding="small" borderWidth="base" borderRadius="base">
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.5rem", borderBottom: "1px solid var(--p-color-border)" }}>数据类型</th>
                  <th style={{ textAlign: "left", padding: "0.25rem 0.5rem", borderBottom: "1px solid var(--p-color-border)" }}>留存规则</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>扫描结果缓存</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>保留最近一次扫描结果；新扫描完成后自动覆盖；卸载 App 时删除</td>
                </tr>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>AI 生成草稿</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>自动保留 30 天，到期后清除</td>
                </tr>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>写回审计记录</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>自动保留 90 天，到期后清除</td>
                </tr>
                <tr>
                  <td style={{ padding: "0.25rem 0.5rem", fontWeight: 600 }}>装饰性图片标记</td>
                  <td style={{ padding: "0.25rem 0.5rem" }}>持久化保存，不自动清除；您可随时手动取消标记</td>
                </tr>
              </tbody>
            </table>
          </s-box>
          <s-text tone="neutral">
            在留存期内，您可以随时在 App 内查阅以上记录。
          </s-text>
        </s-stack>
      </s-box>

      {/* ===== AI 使用边界 ===== */}
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="subdued"
      >
        <s-stack direction="block" gap="small">
          <s-heading>AI 使用边界</s-heading>
          <s-paragraph>
            <strong>扫描阶段不会接触任何 AI 服务。</strong>您的图片在扫描过程中不会被发送给任何第三方。
          </s-paragraph>
          <s-paragraph>
            只有在您<strong>主动点击"生成 Alt Text"</strong>时，系统才会将以下必要信息发送给 AI 服务：
          </s-paragraph>
          <s-stack direction="block" gap="small">
            <s-text>• 所选图片的 Shopify 图片 URL</s-text>
            <s-text>• 必要的上下文（如产品名称等关联信息）</s-text>
          </s-stack>

          <s-text>以下事项我们承诺不会发生：</s-text>
          <s-stack direction="block" gap="small">
            <s-text>• 图片原文件不会被下载、存储或长期缓存</s-text>
            <s-text>• AI 生成不会自动触发，始终需要您主动发起</s-text>
            <s-text>• 生成结果不会自动写回店铺，写回前需经过您的预览与确认</s-text>
            <s-text>• 本产品不处理已有 Alt Text 的图片</s-text>
          </s-stack>

          <s-box padding="small" background="strong" borderRadius="base">
            <s-text tone="caution">
              <strong>重要声明：</strong>AltText Magic 仅帮助您补齐缺失的图片 Alt Text，改善图片层面的无障碍基础，<strong>不替代</strong>整站无障碍审查、法律评估或合规认证。如有相关合规需求，请咨询专业机构。
            </s-text>
          </s-box>
        </s-stack>
      </s-box>

      {/* ===== 确认勾选 ===== */}
      <s-box
        padding="base"
        borderWidth="base"
        borderRadius="base"
        background="strong"
      >
        <label style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => onAcknowledgeChange(e.target.checked)}
            style={{ marginTop: "0.2rem", minWidth: "1rem", minHeight: "1rem" }}
          />
          <s-text>
            我已阅读并理解以上说明，确认可以开始扫描。
          </s-text>
        </label>
      </s-box>
    </s-stack>
  );
}
