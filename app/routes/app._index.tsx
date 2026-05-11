/**
 * File: app/routes/app._index.tsx
 * Purpose: Dashboard 首页。
 *          展示仪表盘分组统计卡片、配额摘要占位、发布时间、
 *          扫描状态提示条与重新扫描按钮。
 */
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useLocation, useNavigate } from "react-router";
import { useState, useEffect, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBootstrapData } from "../../server/modules/bootstrap/bootstrap.service";
import { GroupStatsCard, type GroupStats } from "../components/dashboard/GroupStatsCard";
import { QuotaSummary } from "../components/dashboard/QuotaSummary";
import dashboardGridStyles from "../components/dashboard/DashboardGrid.module.css";
import { formatRelativeTime } from "../lib/format";
import { DEFAULT_SCOPE_FLAG_STATE } from "../lib/scope-utils";

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

/** Loader 返回数据类型 */
interface DashboardLoaderData {
  /** 是否需要确认说明页 */
  needsNoticeAck: boolean;
}

/** GET /api/dashboard 响应体（与 DashboardData 对齐） */
interface DashboardData {
  groups: GroupStats[];
  lastPublishedAt: string | null;
  isScanning: boolean;
  /** 当前运行中的扫描任务 ID */
  activeScanJobId: string | null;
}

/* ------------------------------------------------------------------ */
/*  Loader（服务端）                                                    */
/* ------------------------------------------------------------------ */

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
    needsNoticeAck: bootstrap.needsNoticeAck,
  });
};

/* ------------------------------------------------------------------ */
/*  Dashboard 主组件                                                    */
/* ------------------------------------------------------------------ */

export default function AppDashboardPage() {
  const loaderData = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const data = loaderData as DashboardLoaderData;

  // 需要确认说明页 → 跳转 onboarding
  if (data.needsNoticeAck) {
    return (
      <s-page heading="首次扫描">
        <s-section heading="开始使用">
          <s-stack direction="block" gap="base">
            <s-paragraph>请先完成首次扫描说明确认。</s-paragraph>
            <div
              onClick={() =>
                navigate({
                  pathname: "/app/onboarding",
                  search: location.search,
                })
              }
              style={{ display: "inline-block", cursor: "pointer" }}
            >
              <button
                type="button"
                style={{
                  display: "inline-block",
                  padding: "0.625rem 1rem",
                  border: "none",
                  borderRadius: "0.75rem",
                  background: "var(--p-color-bg-fill-brand)",
                  color: "var(--p-color-text-brand-on-bg-fill)",
                  font: "inherit",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                前往确认
              </button>
            </div>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return <DashboardContent />;
}

/* ------------------------------------------------------------------ */
/*  Dashboard 内容组件（客户端数据获取）                                 */
/* ------------------------------------------------------------------ */

function DashboardContent() {
  const navigate = useNavigate();
  /** Dashboard API 数据 */
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  /** 数据加载中 */
  const [loading, setLoading] = useState(true);
  /** 数据加载错误 */
  const [fetchError, setFetchError] = useState<string | null>(null);
  /** 刷新键（用于触发重新获取） */
  const [refreshKey, setRefreshKey] = useState(0);

  /** 重新扫描状态 */
  const [rescanning, setRescanning] = useState(false);
  const [rescanError, setRescanError] = useState<string | null>(null);

  /* ---------------------------------------------------------------- */
  /*  获取 Dashboard 数据                                              */
  /* ---------------------------------------------------------------- */
  const fetchDashboard = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setFetchError(null);

    try {
      const response = await fetch("/api/dashboard", { signal });

      if (!response.ok) {
        throw new Error(`请求失败 (${response.status})`);
      }

      const result = await response.json() as DashboardData;
      setDashboardData(result);
    } catch (err) {
      // 忽略取消请求的错误
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setFetchError(
        err instanceof Error ? err.message : "加载失败，请刷新页面重试",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboard(controller.signal);

    return () => {
      controller.abort();
    };
  }, [fetchDashboard, refreshKey]);

  /* ---------------------------------------------------------------- */
  /*  当 isScanning 时，定期轮询刷新                                    */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    if (!dashboardData?.isScanning) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRefreshKey((prev) => prev + 1);
    }, 10_000); // 10 秒轮询

    return () => {
      window.clearInterval(intervalId);
    };
  }, [dashboardData?.isScanning]);

  /* ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- */
  /*  重新扫描 → 提取 scanJobId → 导航到进度页                          */
  /* ---------------------------------------------------------------- */
  const handleRescan = useCallback(async () => {
    setRescanning(true);
    setRescanError(null);

    try {
      const response = await fetch("/api/scan/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scopeFlags: DEFAULT_SCOPE_FLAG_STATE,
          noticeVersion: "1.3",
        }),
      });

      if (!response.ok) {
        const body = await response.json() as { error?: string };
        setRescanError(body.error ?? `请求失败 (${response.status})`);
        setRescanning(false);
        return;
      }

      const result = await response.json() as { scanJobId?: string };
      if (result.scanJobId) {
        // 拿到 scanJobId → 导航到扫描进度页
        navigate(`/app/scan-progress?scanJobId=${result.scanJobId}`);
      } else {
        // 兜底：无 scanJobId 时刷新 dashboard 数据
        setRefreshKey((prev) => prev + 1);
      }
    } catch {
      setRescanError("网络错误，请稍后重试");
      setRescanning(false);
    }
  }, [navigate]);
  /* ---------------------------------------------------------------- */
  /*  渲染                                                             */
  /* ---------------------------------------------------------------- */

  const groups = dashboardData?.groups ?? [];
  const lastPublishedAt = dashboardData?.lastPublishedAt ?? null;
  const isScanning = dashboardData?.isScanning ?? false;
  const activeScanJobId = dashboardData?.activeScanJobId ?? null;
  // 当 isScanning 或 rescanning 时，按钮 disabled
  const isScanButtonDisabled = isScanning || rescanning;

  // 加载中骨架屏
  if (loading && !dashboardData) {
    return (
      <s-page heading="Dashboard">
        <s-section heading="仪表盘">
          <s-stack direction="block" gap="base">
            <s-box
              padding="base"
              borderRadius="base"
              background="subdued"
              borderWidth="base"
            >
              <s-text tone="neutral">正在加载仪表盘数据…</s-text>
            </s-box>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  // 加载错误
  if (fetchError && !dashboardData) {
    return (
      <s-page heading="Dashboard">
        <s-section heading="仪表盘">
          <s-box
            padding="base"
            borderRadius="base"
            background="strong"
          >
            <s-text tone="critical">{fetchError}</s-text>
          </s-box>
          <div
            onClick={() => setRefreshKey((prev) => prev + 1)}
            style={{ display: "inline-block", cursor: "pointer", marginTop: "0.75rem" }}
          >
            <s-button variant="secondary" accessibilityLabel="重试">
              重试
            </s-button>
          </div>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Dashboard">
      <s-section heading="仪表盘">
        <s-stack direction="block" gap="large">
          {/* 扫描状态提示条 */}
          {isScanning && (
            <s-box
              padding="base"
              borderRadius="base"
              background="strong"
              borderWidth="base"
            >
              <s-stack direction="inline" gap="small">
                <s-text tone="info">⏳</s-text>
                <s-text>正在扫描…</s-text>
                <s-text tone="neutral">数据可能会暂时滞后。</s-text>
                {activeScanJobId && (
                  <div
                    onClick={() =>
                      navigate(`/app/scan-progress?scanJobId=${activeScanJobId}`)
                    }
                    style={{ display: "inline-block", cursor: "pointer", marginLeft: "0.5rem" }}
                  >
                    <s-button variant="secondary" accessibilityLabel="查看进度">
                      查看进度
                    </s-button>
                  </div>
                )}
              </s-stack>
            </s-box>
          )}

          {/* 重新扫描按钮 */}
          <s-stack direction="inline" gap="base">
            <div
              onClick={isScanButtonDisabled ? undefined : handleRescan}
              style={{
                display: "inline-block",
                cursor: isScanButtonDisabled ? "not-allowed" : "pointer",
                opacity: isScanButtonDisabled ? 0.6 : 1,
              }}
            >
              <s-button
                variant="primary"
                {...(isScanButtonDisabled ? { disabled: true } : {})}
                accessibilityLabel="重新扫描"
              >
                {rescanning ? "正在启动扫描…" : isScanning ? "扫描中…" : "重新扫描"}
              </s-button>
            </div>
          </s-stack>

          {/* 重新扫描错误 */}
          {rescanError && (
            <s-box
              padding="small"
              borderRadius="base"
              background="strong"
            >
              <s-text tone="critical">{rescanError}</s-text>
            </s-box>
          )}

          {/* 上次发布时间 */}
          <s-stack direction="inline" gap="small">
            <s-text tone="neutral">上次数据更新：</s-text>
            <s-text>
              {formatRelativeTime(lastPublishedAt)}
            </s-text>
          </s-stack>

          {/* 分组统计卡片网格（响应式：桌面四列 / 平板两列 / 手机单列） */}
          {groups.length > 0 ? (
            <div className={dashboardGridStyles.dashboardGrid}>
              {groups.map((group) => (
                <GroupStatsCard key={group.groupType} stats={group} />
              ))}
            </div>
          ) : (
            <s-box
              padding="base"
              borderRadius="base"
              background="subdued"
              borderWidth="base"
            >
              <s-text tone="neutral">
                暂无统计数据。请完成首次扫描后查看仪表盘。
              </s-text>
            </s-box>
          )}

          {/* 计划与配额摘要占位 */}
          <QuotaSummary />
        </s-stack>
      </s-section>
    </s-page>
  );
}
