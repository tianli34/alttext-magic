/**
 * File: app/components/dashboard/ScanProgressFloat.tsx
 * Purpose: 扫描进度浮窗组件（右下角固定，可最小化）。
 *          替代原独立进度页，在 Dashboard 上实时展示扫描进度、
 *          task 粒度状态、异常提示、停止扫描与重新扫描操作。
 *          整合 SSE 实时推送 + scan/status 刷新恢复（复用 useBatchProgress）。
 */
import { useState } from "react";
import { useBatchProgress } from "../../hooks/useBatchProgress";
import { ProgressBar } from "../common/ProgressBar";
import styles from "./ScanProgressFloat.module.css";

interface ScanProgressFloatProps {
  /** 扫描任务 ID */
  scanJobId: string;
  /** 关闭浮窗回调（终态时可用） */
  onClose: () => void;
  /** 重新扫描回调，参数为新的 scanJobId */
  onRescan: (newScanJobId: string) => void;
}

/** 资源类型中文标签 */
const RESOURCE_LABELS: Record<string, string> = {
  PRODUCT_MEDIA: "商品",
  FILES: "文件",
  COLLECTION_IMAGE: "合集",
  ARTICLE_IMAGE: "文章",
};

/** 资源类型固定展示顺序（与扫描调度顺序一致） */
const ALL_RESOURCE_TYPES_ORDER = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
] as const;

/**
 * 扫描进度浮窗。
 */
export function ScanProgressFloat({
  scanJobId,
  onClose,
  onRescan,
}: ScanProgressFloatProps) {
  const [minimized, setMinimized] = useState(false);

  const {
    progress,
    scanStatus,
    loading,
    isScanning,
    percent,
    imagePercent,
    imageFetchFailed,
    isDiscovering,
    discoveredObjects,
    etaLabel,
    phaseLabel,
    isTerminal,
    sseError,
    handleRescan,
    rescanning,
    rescanError,
    canStop,
    handleStop,
    stopping,
    stopError,
  } = useBatchProgress(scanJobId);

  const message = progress?.message ?? "";
  const tasks = scanStatus?.tasks ?? [];

  // 每类资源的图片处理进度（优先取实时 resourceTotals，按固定资源类型顺序展示）
  // 合并 task 级状态/错误，用于进度条色调与失败提示
  const resourceProgressList = ALL_RESOURCE_TYPES_ORDER.map((resourceType) => {
    const totals = progress?.resourceTotals?.[resourceType];
    const task = tasks.find((t) => t.resourceType === resourceType);
    const totalImages = totals?.totalImages ?? 0;
    const processedImages = totals?.processedImages ?? 0;
    const failedImages = totals?.failedImages ?? 0;
    // 该资源是否图片获取失败：终态却未统计到任何图片，不应伪造 100%
    const resourceFetchFailed =
      totalImages === 0 &&
      (imageFetchFailed || task?.status === "SUCCESS" || task?.status === "FAILED");
    const percent =
      totalImages > 0
        ? Math.min(100, Math.round((processedImages / totalImages) * 100))
        : resourceFetchFailed
          ? 0
          : 0;
    return {
      resourceType,
      label: RESOURCE_LABELS[resourceType] ?? resourceType,
      totalImages,
      processedImages,
      failedImages,
      percent,
      resourceFetchFailed,
      status: task?.status ?? "PENDING",
      error: task?.error ?? null,
    };
  });

  // 处理阶段优先用图片级百分比；发现阶段尚无图片数据时回退到任务级百分比
  const hasImageData = !!progress && (progress.totalImages ?? 0) > 0;
  const displayPercent = hasImageData ? imagePercent : percent;
  // [DEBUG] 终态进度排查
  if (process.env.NODE_ENV !== "production") {
    console.log("[DEBUG ScanProgressFloat]", {
      hasImageData,
      displayPercent,
      imageFetchFailed,
      progressTotalImages: progress?.totalImages ?? null,
      scanStatusProgressTotalImages: scanStatus?.progress?.totalImages ?? null,
      resourceProgressList: resourceProgressList.map((rp) => ({
        rt: rp.resourceType,
        totalImages: rp.totalImages,
        percent: rp.percent,
        resourceFetchFailed: rp.resourceFetchFailed,
        status: rp.status,
      })),
    });
  }
  const hasError =
    scanStatus?.scanJob?.status === "FAILED" || progress?.phase === "failed";

  // 标题栏状态图标与文案
  const statusIcon = isScanning ? "⏳" : hasError ? "❌" : "✅";
  const statusTone = isScanning ? "info" : hasError ? "critical" : "success";
  const title =
    loading && !progress
      ? "正在加载…"
      : isScanning
        ? "正在扫描店铺…"
        : hasError
          ? "扫描失败"
          : "扫描完成";

  return (
    <div className={styles.float}>
      {/* 标题栏 */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <s-text tone={statusTone}>{statusIcon}</s-text>
          <s-text>{title}</s-text>
          {minimized &&
            (isDiscovering ? (
              <s-text tone="neutral">收集中…</s-text>
            ) : (
              <s-text tone="neutral">{percent}%</s-text>
            ))}
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setMinimized((prev) => !prev)}
            aria-label={minimized ? "展开" : "最小化"}
          >
            {minimized ? "▢" : "—"}
          </button>
          {isTerminal && (
            <button
              type="button"
              className={styles.iconButton}
              onClick={onClose}
              aria-label="关闭"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* 主体（最小化时隐藏） */}
      {!minimized && (
        <div className={styles.body}>
          <s-stack direction="block" gap="base">
            {/* 阶段描述 */}
            {message && <s-paragraph>{message}</s-paragraph>}

            {/* 进度条：发现阶段用不确定进度（无限滑动），处理阶段用精确百分比 */}
            <ProgressBar
              percent={displayPercent}
              animated={isScanning}
              size="large"
              indeterminate={isDiscovering}
            />

            {/* 发现阶段：不确定进度 + 已发现对象计数 */}
            {isDiscovering ? (
              <s-stack direction="inline" gap="small">
                <s-spinner size="base" accessibilityLabel="正在收集图片清单" />
                <s-text tone="neutral">
                  正在收集图片：已发现{" "}
                  {discoveredObjects.toLocaleString("zh-CN")} 个对象…
                </s-text>
              </s-stack>
                ) : (
                  /* 处理阶段：百分比 + 阶段标签 + 图片计数 */
                  <s-stack direction="inline" gap="small">
                    <s-text tone="neutral">{displayPercent}%</s-text>
                    <s-text tone="neutral">·</s-text>
                    <s-text tone="neutral">{phaseLabel}</s-text>
                    {progress && hasImageData && (
                      <>
                        <s-text tone="neutral">·</s-text>
                        <s-text tone="neutral">
                          已分析 {progress.processedImages.toLocaleString("zh-CN")}/
                          {progress.totalImages.toLocaleString("zh-CN")} 张
                        </s-text>
                        {etaLabel && (
                          <>
                            <s-text tone="neutral">·</s-text>
                            <s-text tone="neutral">预计剩余 {etaLabel}</s-text>
                          </>
                        )}
                      </>
                    )}
                  </s-stack>
                )}

            {/* 图片获取失败提示：终态但始终未能解析出图片总数 */}
            {imageFetchFailed && (
              <s-box padding="small" borderRadius="base" background="strong">
                <s-text tone="critical">图片获取失败，未能统计到任何图片。</s-text>
              </s-box>
            )}

            {/* SSE 连接错误提示 */}
            {sseError && (
              <s-box padding="small" borderRadius="base" background="strong">
                <s-text tone="caution">
                  实时推送连接异常（{sseError}），页面会自动重连，并通过状态轮询继续刷新。
                </s-text>
              </s-box>
            )}

            {/* 每类资源独立进度条：展示该类真实的图片处理进度 */}
            <s-stack direction="block" gap="small">
              {resourceProgressList.map((rp) => {
                const tone =
                  rp.status === "FAILED"
                    ? "critical"
                    : rp.status === "SUCCESS"
                      ? "success"
                      : rp.status === "RUNNING" || rp.status === "PARSING"
                        ? "info"
                        : "neutral";
                const isFailed = rp.status === "FAILED";
                const showIndeterminate =
                  isDiscovering && (rp.status === "RUNNING" || rp.status === "PENDING" || rp.status === "PARSING");
                const metaText =
                  rp.totalImages > 0
                    ? `已分析 ${rp.processedImages.toLocaleString("zh-CN")}/${rp.totalImages.toLocaleString("zh-CN")} 张`
                    : rp.resourceFetchFailed
                      ? "图片获取失败"
                      : rp.status === "SUCCESS"
                        ? "已完成"
                        : rp.status === "FAILED"
                          ? "处理失败"
                          : isDiscovering
                            ? "收集中…"
                            : "等待处理…";
                return (
                  <div key={rp.resourceType} className={styles.resourceRow}>
                    <div className={styles.resourceHead}>
                      <s-text>{rp.label}</s-text>
                      <s-text tone={tone}>{rp.percent}%</s-text>
                    </div>
                    <ProgressBar
                      percent={rp.percent}
                      animated={rp.status === "RUNNING" || rp.status === "PARSING"}
                      size="small"
                      indeterminate={showIndeterminate}
                    />
                    <s-stack direction="inline" gap="small">
                      <s-text tone="neutral">{metaText}</s-text>
                      {isFailed && rp.error && (
                        <s-text tone="critical">{rp.error}</s-text>
                      )}
                    </s-stack>
                  </div>
                );
              })}
            </s-stack>

            {/* 扫描失败错误详情 */}
            {hasError && scanStatus?.scanJob?.error && (
              <s-box padding="small" borderRadius="base" background="strong">
                <s-text tone="critical">
                  错误详情: {scanStatus.scanJob.error}
                </s-text>
              </s-box>
            )}

            {/* 操作按钮：React 18 的 onClick/disabled 在 Polaris WC 上不可靠，用原生 div 包裹 */}
            {isTerminal && (
              <div
                onClick={
                  rescanning
                    ? undefined
                    : async () => {
                        const newScanJobId = await handleRescan();
                        if (newScanJobId) {
                          onRescan(newScanJobId);
                        }
                      }
                }
                style={{
                  display: "inline-block",
                  cursor: rescanning ? "not-allowed" : "pointer",
                }}
              >
                <s-button
                  variant="secondary"
                  {...(rescanning ? { disabled: true } : {})}
                  accessibilityLabel="重新扫描"
                >
                  {rescanning ? "正在启动…" : "重新扫描"}
                </s-button>
              </div>
            )}

            {!isTerminal && canStop && (
              <div
                onClick={stopping ? undefined : handleStop}
                style={{ display: "inline-block" }}
              >
                <s-button
                  variant="secondary"
                  tone="critical"
                  {...(stopping ? { disabled: true } : {})}
                  accessibilityLabel="停止扫描"
                >
                  {stopping ? "正在停止…" : "停止扫描"}
                </s-button>
              </div>
            )}

            {/* 重新扫描错误 */}
            {rescanError && (
              <s-box padding="small" borderRadius="base" background="strong">
                <s-text tone="critical">{rescanError}</s-text>
              </s-box>
            )}

            {/* 停止扫描错误 */}
            {stopError && (
              <s-box padding="small" borderRadius="base" background="strong">
                <s-text tone="critical">{stopError}</s-text>
              </s-box>
            )}
          </s-stack>
        </div>
      )}
    </div>
  );
}
