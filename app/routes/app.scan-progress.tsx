/**
 * File: app/routes/app.scan-progress.tsx
 * Purpose: 扫描进度页路由。
 *          从 URL 查询参数获取 scanJobId，
 *          使用 SSE 实时展示扫描进度/阶段，完成时显示"扫描完成"与返回入口。
 *
 * 入口场景:
 *   - Dashboard 重新扫描 → 导航到 /app/scan-progress?scanJobId=...
 *   - Onboarding 首次扫描 → 导航到 /app/scan-progress?scanJobId=...
 */
import { useSearchParams, useLocation } from "react-router";
import { ScanProgressPage } from "../components/dashboard/ScanStatusBanner";

export default function ScanProgressRoute() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const scanJobId = searchParams.get("scanJobId");

  if (!scanJobId) {
    return (
      <s-page heading="扫描进度">
        <s-section heading="参数缺失">
          <s-stack direction="block" gap="base">
            <s-box
              padding="base"
              borderRadius="base"
              background="strong"
            >
              <s-text tone="critical">
                缺少 scanJobId 参数，无法加载扫描进度。
              </s-text>
            </s-box>
            <div
              onClick={() =>
                window.location.assign(`/app${location.search}`)
              }
              style={{ display: "inline-block", cursor: "pointer" }}
            >
              <s-button variant="primary" accessibilityLabel="返回仪表盘">
                返回仪表盘
              </s-button>
            </div>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  /* key={scanJobId} 确保重新扫描导航到新 scanJobId 时完全重新挂载组件，
     避免 useSSE/useScanStatus 的旧状态（100% done）残留覆盖新扫描状态 */
  return <ScanProgressPage key={scanJobId} scanJobId={scanJobId} />;
}
