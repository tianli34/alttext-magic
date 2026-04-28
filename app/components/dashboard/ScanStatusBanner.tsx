/**
 * File: app/components/dashboard/ScanStatusBanner.tsx
 * Purpose: 扫描进度页面组件。
 *          展示实时扫描进度、task 粒度状态、异常提示和重新扫描按钮。
 *          整合 SSE 实时推送 + scan/status 刷新恢复。
 */
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useBatchProgress } from "../../hooks/useBatchProgress";
import { ProgressBar } from "../common/ProgressBar";
import { StatusBadge } from "../common/StatusBadge";
import type { ScanTaskStatus } from "../../hooks/useScanStatus";

interface ScanProgressPageProps {
  /** 扫描任务 ID */
  scanJobId: string;
}

/** 资源类型中文标签 */
const RESOURCE_LABELS: Record<string, string> = {
  PRODUCT_MEDIA: "商品图片",
  FILES: "文件图片",
  COLLECTION_IMAGE: "合集图片",
  ARTICLE_IMAGE: "文章图片",
};

/**
 * 扫描进度页面。
 */
export function ScanProgressPage({ scanJobId }: ScanProgressPageProps) {
  const navigate = useNavigate();

  const handleTerminal = useCallback(() => {
    // 终态后 3 秒自动刷新到 Dashboard
    setTimeout(() => {
      navigate("/app");
    }, 3000);
  }, [navigate]);

  const {
    progress,
    scanStatus,
    loading,
    isScanning,
    percent,
    phaseLabel,
    isTerminal,
    sseError,
    handleRescan,
    rescanning,
    rescanError,
  } = useBatchProgress(scanJobId, handleTerminal);

  // 加载中骨架屏
  if (loading && !progress) {
    return (
      <s-page heading="扫描进度">
        <s-section heading="正在加载…">
          <s-stack direction="block" gap="base">
            {/* 骨架屏 */}
            <s-box
              padding="base"
              borderRadius="base"
              background="subdued"
              borderWidth="base"
            >
              <s-stack direction="block" gap="base">
                <s-text tone="neutral">正在获取扫描状态…</s-text>
                <ProgressBar percent={0} animated size="medium" />
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  const message = progress?.message ?? "";
  const tasks = scanStatus?.tasks ?? [];
  const hasError = scanStatus?.scanJob?.status === "FAILED" || progress?.phase === "failed";

  return (
    <s-page heading="扫描进度">
      <s-section heading="正在扫描您的店铺…">
        <s-stack direction="block" gap="large">
          {/* 进度概览 */}
          <s-box
            padding="base"
            borderRadius="base"
            background="subdued"
            borderWidth="base"
          >
            <s-stack direction="block" gap="base">
              {/* 进度标题 */}
              <s-stack direction="inline" gap="base">
                {isScanning && (
                  <s-text tone="info">⏳</s-text>
                )}
                {isTerminal && !hasError && (
                  <s-text tone="success">✅</s-text>
                )}
                {hasError && (
                  <s-text tone="critical">❌</s-text>
                )}
                <s-heading>
                  {isScanning
                    ? "正在扫描您的店铺…"
                    : hasError
                      ? "扫描失败"
                      : "扫描完成"}
                </s-heading>
              </s-stack>

              {/* 阶段描述 */}
              {message && <s-paragraph>{message}</s-paragraph>}

              {/* 进度条 */}
              <ProgressBar
                percent={percent}
                animated={isScanning}
                size="large"
              />

              {/* 百分比 + 阶段标签 */}
              <s-stack direction="inline" gap="base">
                <s-text tone="neutral">{percent}%</s-text>
                <s-text tone="neutral">·</s-text>
                <s-text tone="neutral">{phaseLabel}</s-text>
                {progress && (
                  <>
                    <s-text tone="neutral">·</s-text>
                    <s-text tone="neutral">
                      {progress.completedTasks}/{progress.totalTasks} 任务
                    </s-text>
                  </>
                )}
              </s-stack>
            </s-stack>
          </s-box>

          {/* SSE 连接错误提示 */}
          {sseError && (
            <s-box
              padding="small"
              borderRadius="base"
              background="strong"
            >
              <s-text tone="caution">
                实时推送连接中断（{sseError}），页面将在下次数据更新时自动恢复。
              </s-text>
            </s-box>
          )}

          {/* Task 粒度状态 */}
          {tasks.length > 0 && (
            <s-box
              padding="base"
              borderRadius="base"
              borderWidth="base"
            >
              <s-stack direction="block" gap="base">
                <s-heading>任务状态</s-heading>
                {tasks.map((task: ScanTaskStatus) => (
                  <s-box
                    key={task.id}
                    padding="small"
                    borderRadius="base"
                    background="subdued"
                  >
                    <s-stack direction="inline" gap="base">
                      <s-text>
                        {RESOURCE_LABELS[task.resourceType] ?? task.resourceType}
                      </s-text>
                      <StatusBadge status={task.status} />
                      {task.error && (
                        <s-text tone="critical">{task.error}</s-text>
                      )}
                      {task.latestAttempt && task.latestAttempt.parsedRows > 0 && (
                        <s-text tone="neutral">
                          解析行数: {task.latestAttempt.parsedRows}
                        </s-text>
                      )}
                    </s-stack>
                  </s-box>
                ))}
              </s-stack>
            </s-box>
          )}

          {/* 扫描失败错误详情 */}
          {hasError && scanStatus?.scanJob?.error && (
            <s-box
              padding="small"
              borderRadius="base"
              background="strong"
            >
              <s-text tone="critical">
                错误详情: {scanStatus.scanJob.error}
              </s-text>
            </s-box>
          )}

          {/* 操作按钮 */}
          {isTerminal && (
            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={() => navigate("/app")}
                accessibilityLabel="返回仪表盘"
              >
                返回仪表盘
              </s-button>
              <s-button
                variant="secondary"
                onClick={handleRescan}
                disabled={rescanning}
                accessibilityLabel="重新扫描"
              >
                {rescanning ? "正在启动…" : "重新扫描"}
              </s-button>
            </s-stack>
          )}

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
        </s-stack>
      </s-section>
    </s-page>
  );
}
