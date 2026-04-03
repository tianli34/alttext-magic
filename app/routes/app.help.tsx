/**
 * Help 占位页。
 * 当前仅提供 Embedded App 导航壳所需的最小页面结构，不承载真实业务逻辑。
 */
import { AppPlaceholderPage } from "../components/common/AppPlaceholderPage";

export default function AppHelpPage() {
  return (
    <AppPlaceholderPage
      title="Help"
      description="帮助中心页面占位中，后续将在这里补充使用说明、常见问题和支持入口。"
    />
  );
}
