/**
 * File: app/routes/app._index.tsx
 * Purpose: Dashboard 首页。
 *          当有正在运行的扫描时展示实时进度页面；
 *          否则展示仪表盘占位内容。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBootstrapData } from "../../server/modules/bootstrap/bootstrap.service";
import { ScanProgressPage } from "../components/dashboard/ScanStatusBanner";

/** Loader 返回数据类型 */
interface DashboardLoaderData {
  /** 最近扫描 Job ID（无扫描时为 null） */
  scanJobId: string | null;
  /** 是否有正在运行的扫描 */
  isRunning: boolean;
  /** 是否需要确认说明页 */
  needsNoticeAck: boolean;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const bootstrap = await getBootstrapData(shop.id);

  return Response.json({
    scanJobId: bootstrap.latestScan?.scanJobId ?? null,
    isRunning: bootstrap.latestScan?.isRunning ?? false,
    needsNoticeAck: bootstrap.needsNoticeAck,
  });
};

export default function AppDashboardPage() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const data = loaderData as DashboardLoaderData;

  // 需要确认说明页 → 跳转 onboarding
  if (data.needsNoticeAck) {
    return (
      <s-page heading="首次扫描">
        <s-section heading="开始使用">
          <s-stack direction="block" gap="base">
            <s-paragraph>请先完成首次扫描说明确认。</s-paragraph>
            <s-button
              variant="primary"
              onClick={() => navigate("/app/onboarding")}
            >
              前往确认
            </s-button>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  // 正在扫描 → 展示进度页
  if (data.isRunning && data.scanJobId) {
    return <ScanProgressPage scanJobId={data.scanJobId} />;
  }

  // 默认 → 占位 Dashboard
  return (
    <s-page heading="Dashboard">
      <s-section heading="仪表盘">
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-stack direction="block" gap="small">
            <s-heading>仪表盘</s-heading>
            <s-paragraph>
              仪表盘页面占位中，后续将在这里展示店铺扫描概览、配额摘要和处理状态。
            </s-paragraph>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}
