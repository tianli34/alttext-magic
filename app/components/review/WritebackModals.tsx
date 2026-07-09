/**
 * File: app/components/review/WritebackModals.tsx
 * Purpose: 写回进度弹窗 & 写回汇总弹窗
 */
import styles from "./WritebackModals.module.css";
import { ProgressBar } from "../common/ProgressBar";

// ============================================================================
// 类型定义
// ============================================================================

type AltPlane = "FILE_ALT" | "COLLECTION_IMAGE_ALT" | "ARTICLE_IMAGE_ALT";

type WritebackBatchStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "FAILED";

interface WritebackProgressData {
  batchId: string;
  status: WritebackBatchStatus;
  total: number;
  success: number;
  fail: number;
  skip: number;
  pending: number;
}

interface WritebackTypeStat {
  altPlane: AltPlane;
  total: number;
  success: number;
  fail: number;
  skip: number;
}

interface WritebackBatchDetail extends WritebackProgressData {
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  typeStats: WritebackTypeStat[];
  isTerminal: boolean;
}

export interface WritebackProgressModalProps {
  progress: WritebackProgressData | null;
  connected: boolean;
  percent: number;
  error: string | null;
}

export interface WritebackSummaryModalProps {
  batchDetail: WritebackBatchDetail;
  onViewFailures: () => void;
  onViewHistory: () => void;
  onClose: () => void;
}

// ============================================================================
// 常量
// ============================================================================

const ALT_PLANE_LABELS: Record<AltPlane, string> = {
  FILE_ALT: "文件",
  COLLECTION_IMAGE_ALT: "合集",
  ARTICLE_IMAGE_ALT: "文章",
};

const BATCH_STATUS_LABELS: Record<WritebackBatchStatus, string> = {
  PENDING: "等待中",
  RUNNING: "写回中",
  SUCCESS: "写回完成",
  PARTIAL_SUCCESS: "部分失败",
  FAILED: "写回失败",
};

function isTerminalBatch(status: WritebackBatchStatus): boolean {
  return status === "SUCCESS" || status === "PARTIAL_SUCCESS" || status === "FAILED";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "处理中";
  const seconds = Math.max(Math.round(durationMs / 1000), 0);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

// ============================================================================
// 写回进度弹窗
// ============================================================================

export function WritebackProgressModal({
  progress,
  connected,
  percent,
  error,
}: WritebackProgressModalProps) {
  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <div className={styles.progressHeader}>
            <s-heading>
              {progress
                ? BATCH_STATUS_LABELS[progress.status] ?? progress.status
                : "写回中"}
            </s-heading>
            <s-text tone="neutral">
              {connected ? "实时连接中" : "等待进度更新"}
            </s-text>
          </div>

          <ProgressBar
            percent={percent}
            animated={progress ? !isTerminalBatch(progress.status) : true}
            size="large"
          />

          {progress && (
            <div className={styles.progressStats}>
              <span>
                已完成 {(progress.success + progress.fail + progress.skip).toLocaleString("zh-CN")}
                /{progress.total.toLocaleString("zh-CN")}
              </span>
              <span>成功 {progress.success.toLocaleString("zh-CN")}</span>
              <span>跳过 {progress.skip.toLocaleString("zh-CN")}</span>
              <span>失败 {progress.fail.toLocaleString("zh-CN")}</span>
              <span>待处理 {progress.pending.toLocaleString("zh-CN")}</span>
            </div>
          )}

          {error && (
            <s-text tone="caution">{error}</s-text>
          )}

          {!error && progress && !isTerminalBatch(progress.status) && (
            <s-text tone="neutral">
              AI 正在逐一写回，请勿关闭此页面。
            </s-text>
          )}
        </s-stack>
      </div>
    </div>
  );
}

// ============================================================================
// 写回汇总弹窗
// ============================================================================

export function WritebackSummaryModal({
  batchDetail,
  onViewFailures,
  onViewHistory,
  onClose,
}: WritebackSummaryModalProps) {
  const allSuccess = batchDetail.fail === 0;
  const hasFailures = batchDetail.fail > 0;

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <s-heading>
            {hasFailures ? "写回已结束，存在失败项" : "写回已全部完成"}
          </s-heading>

          <div className={styles.summaryStats}>
            <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
              <span className={`${styles.statNumber} ${styles.statNumberSuccess}`}>
                {batchDetail.total}
              </span>
              <span className={styles.statLabel}>总数</span>
            </div>
            <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
              <span className={`${styles.statNumber} ${styles.statNumberSuccess}`}>
                {batchDetail.success}
              </span>
              <span className={styles.statLabel}>成功</span>
            </div>
            <div className={`${styles.statCard} ${styles.statCardCaution}`}>
              <span className={`${styles.statNumber} ${styles.statNumberCaution}`}>
                {batchDetail.skip}
              </span>
              <span className={styles.statLabel}>跳过</span>
            </div>
            <div className={`${styles.statCard} ${allSuccess ? styles.statCardSuccess : styles.statCardCritical}`}>
              <span className={`${styles.statNumber} ${allSuccess ? styles.statNumberSuccess : styles.statNumberCritical}`}>
                {batchDetail.fail}
              </span>
              <span className={styles.statLabel}>失败</span>
            </div>
          </div>

          <s-text tone="neutral">
            耗时 {formatDuration(batchDetail.durationMs)}
          </s-text>

          {batchDetail.typeStats.length > 0 && (
            <div className={styles.typeStats}>
              {batchDetail.typeStats.map((stat) => (
                <s-text key={stat.altPlane} tone="neutral">
                  {ALT_PLANE_LABELS[stat.altPlane]}：成功 {stat.success}，跳过 {stat.skip}，失败 {stat.fail}
                </s-text>
              ))}
            </div>
          )}

          <div className={styles.actions}>
            {hasFailures && (
              <button type="button" onClick={onViewFailures}>
                <s-button variant="secondary" accessibilityLabel="查看失败项">
                  查看失败项
                </s-button>
              </button>
            )}
            <button type="button" onClick={onViewHistory}>
              <s-button variant="secondary" accessibilityLabel="查看写回历史">
                查看写回历史
              </s-button>
            </button>
            <button type="button" onClick={onClose}>
              <s-button variant="primary" accessibilityLabel="返回审阅列表">
                返回审阅列表
              </s-button>
            </button>
          </div>
        </s-stack>
      </div>
    </div>
  );
}
