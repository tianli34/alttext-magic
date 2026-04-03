/**
 * 占位页面壳组件。
 * 统一渲染 Embedded App Phase 1 的极简 Polaris 页面内容，避免各页面重复结构。
 */
type AppPlaceholderPageProps = {
  title: string;
  description: string;
};

export function AppPlaceholderPage({
  title,
  description,
}: AppPlaceholderPageProps) {
  return (
    <s-page heading={title}>
      <s-section heading={title}>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="small">
            <s-heading>{title}</s-heading>
            <s-paragraph>{description}</s-paragraph>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}
