/**
 * File: app/components/generation/GenerationFlow.tsx
 * Purpose: 生成触发交互流程组件。
 *          包含预检确认 Modal、生成进度展示 Modal、自动写回进度展示 Modal、完成汇总 Modal。
 *          由外部传入 useGenerationFlow 返回值驱动渲染。
 */
import { useLocation, useNavigate } from "react-router";
import styles from "./GenerationFlow.module.css";
import { buildAppPath } from "../../lib/app-navigation";
import type {
  GenerationFlowPhase,
  PreflightResult,
  GenerationSummary,
} from "../../hooks/useGenerationFlow";
import type { GenerationProgressData } from "../../hooks/useGenerationSSE";
import type { WritebackProgressData } from "../../hooks/useWritebackSSE";

// ============================================================================
// 类型定义
// ============================================================================

interface GenerationFlowProps {
  /** 当前阶段 */
  phase: GenerationFlowPhase;
  /** Preflight 结果 */
  preflightResult: PreflightResult | null;
  /** 总候选数 */
  totalCount: number;
  /** SSE 进度数据 */
  progress: GenerationProgressData | null;
  /** 汇总数据 */
  summary: GenerationSummary | null;
  /** 错误信息 */
  error: string | null;
  /** Preflight 预检进行中 */
  preflightLoading: boolean;
  /** SSE 是否已连接 */
  connected: boolean;
  /** 进度百分比 0-100 */
  percent: number;
  /** 写回 SSE 实时进度数据 */
  writebackProgress: WritebackProgressData | null;
  /** 写回 SSE 是否已连接 */
  writebackConnected: boolean;
  /** 写回进度百分比 0-100 */
  writebackPercent: number;
  /** 写回 SSE 连接错误 */
  writebackError: string | null;
  /** 确认并启动生成 */
  onConfirmAndStart: () => void;
  /** 取消 */
  onCancel: () => void;
  /** 关闭汇总并刷新列表 */
  onCloseSummary: () => void;
}

// ============================================================================
// 主组件
// ============================================================================

export function GenerationFlow({
  phase,
  preflightResult,
  totalCount,
  progress,
  summary,
  error,
  preflightLoading,
  connected,
  percent,
  writebackProgress,
  writebackConnected,
  writebackPercent,
  writebackError,
  onConfirmAndStart,
  onCancel,
  onCloseSummary,
}: GenerationFlowProps) {
  if (phase === "IDLE" || phase === "PREFLIGHT_LOADING") {
    return null;
  }

  if (phase === "CONFIRMING") {
    return (
      <ConfirmModal
        preflightResult={preflightResult}
        totalCount={totalCount}
        error={error}
        preflightLoading={preflightLoading}
        onConfirm={onConfirmAndStart}
        onCancel={onCancel}
      />
    );
  }

  if (phase === "STARTING") {
    return (
      <div className={styles.overlay}>
        <div className={styles.modal}>
          <s-stack direction="block" gap="base">
            <s-heading>正在启动生成…</s-heading>
            <s-text tone="neutral">正在准备生成任务，请稍候。</s-text>
          </s-stack>
        </div>
      </div>
    );
  }

  if (phase === "GENERATING") {
    return (
      <ProgressModal
        totalCount={totalCount}
        progress={progress}
        connected={connected}
        percent={percent}
        error={error}
      />
    );
  }

  if (phase === "WRITEBACK") {
    return (
      <WritebackProgressView
        progress={writebackProgress}
        connected={writebackConnected}
        percent={writebackPercent}
        error={writebackError}
      />
    );
  }

  if (phase === "SUMMARY") {
    return (
      <SummaryModal
        summary={summary}
        totalCount={totalCount}
        onClose={onCloseSummary}
      />
    );
  }

  return null;
}

// ============================================================================
// 预检确认 Modal
// ============================================================================

interface ConfirmModalProps {
  preflightResult: PreflightResult | null;
  totalCount: number;
  error: string | null;
  preflightLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmModal({
  preflightResult,
  totalCount,
  error,
  preflightLoading,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const enough = preflightResult?.enough ?? false;
  const currentPlan = preflightResult?.currentPlan ?? "FREE";
  const isMaxPlan = currentPlan === "MAX";

  const handleUpgrade = () => {
    navigate(buildAppPath("/app/billing", location.search));
  };

  const handleBuyPack = () => {
    navigate(buildAppPath("/app/billing", location.search));
  };

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <s-stack direction="block" gap="base">
          <s-heading>确认生成 Alt Text</s-heading>

          <s-text>
            即将为 <strong>{totalCount}</strong> 张图片生成 Alt Text，
            预计消耗 <strong>{totalCount}</strong> 额度。
          </s-text>

          {/* 预检进行中提示 */}
          {preflightLoading && (
            <s-text tone="neutral">正在检查额度…</s-text>
          )}

          {/* 当前额度 */}
          {preflightResult && (
            <s-text>
              当前额度：<strong>{preflightResult.totalRemaining}</strong>
            </s-text>
          )}

          {/* 额度不足警告与引导 */}
          {preflightResult && !enough && (
            <s-box padding="base" borderRadius="base" background="strong">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small">
                  <s-heading>余额不足</s-heading>
                </s-stack>
                <s-text tone="critical">
                  当前余额 <strong>{preflightResult.totalRemaining}</strong>，
                  生成所选 <strong>{totalCount}</strong> 张图片需要更多额度。
                </s-text>
                
                <s-stack direction="inline" gap="small">
                  {!isMaxPlan && (
                    <div onClick={handleUpgrade} style={{ cursor: "pointer" }}>
                      <s-button variant="primary" accessibilityLabel="Upgrade Plan">
                        Upgrade Plan
                      </s-button>
                    </div>
                  )}
                  <div onClick={handleBuyPack} style={{ cursor: "pointer" }}>
                    <s-button variant="secondary" accessibilityLabel="Buy Extra Pack">
                      Buy Extra Pack
                    </s-button>
                  </div>
                </s-stack>
              </s-stack>
            </s-box>
          )}

          {/* 错误信息 */}
          {error && (
            <s-box padding="base" borderRadius="base" background="strong">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          )}

          {/* 操作按钮 */}
          <div className={styles.actions}>
            <div onClick={onCancel} style={{ display: "inline-block", cursor: "pointer" }}>
              <s-button variant="secondary" accessibilityLabel="取消">
                取消
              </s-button>
            </div>
            {(preflightResult === null || enough) && (
              <div
                onClick={onConfirm}
                style={{ display: "inline-block", cursor: "pointer" }}
              >
                <s-button
                  variant="primary"
                  accessibilityLabel="生成"
                >
                  Generate
                </s-button>
              </div>
            )}
          </div>
        </s-stack>
      </div>
    </div>
  );
}

// ============================================================================
// 进度展示 Modal
// ============================================================================

interface ProgressModalProps {
  totalCount: number;
  progress: GenerationProgressData | null;
  connected: boolean;
  percent: number;
  error: string | null;
}

function ProgressModal({
  totalCount,
  progress,
  connected,
  percent,
  error,
}: ProgressModalProps) {
  const current = progress?.current ?? 0;
  const total = progress?.total ?? totalCount;

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <s-heading>正在生成 Alt Text…</s-heading>

          {/* 进度条 */}
          <div className={styles.progressContainer}>
            <div className={styles.progressBarTrack}>
              <div
                className={`${styles.progressBarFill} ${
                  percent >= 100 ? styles.progressBarFillComplete : ""
                }`}
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
            <div className={styles.progressCount}>
              <s-text tone="neutral">
                {connected ? "已连接" : "连接中…"}
              </s-text>
              <s-text>
                {current} / {total} 已完成
              </s-text>
            </div>
          </div>

          {/* 失败计数 */}
          {progress && progress.failed > 0 && (
            <s-text tone="critical">
              {progress.failed} 张图片生成失败
            </s-text>
          )}

          {/* 跳过计数 */}
          {progress && progress.skipped > 0 && (
            <s-text tone="caution">
              {progress.skipped} 张图片已跳过（已有 Alt Text）
            </s-text>
          )}

          {/* 错误信息 */}
          {error && (
            <s-box padding="base" borderRadius="base" background="strong">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          )}

          {/* 处理中提示 */}
          {!error && percent < 100 && (
            <s-text tone="neutral">
              AI 正在为每张图片生成 Alt Text，请勿关闭此页面。
            </s-text>
          )}
        </s-stack>
      </div>
    </div>
  );
}

// ============================================================================
// 自动写回进度展示
// ============================================================================

interface WritebackProgressViewProps {
  progress: WritebackProgressData | null;
  connected: boolean;
  percent: number;
  error: string | null;
}

function WritebackProgressView({
  progress,
  connected,
  percent,
  error,
}: WritebackProgressViewProps) {
  const total = progress?.total ?? 0;
  const done = (progress?.success ?? 0) + (progress?.fail ?? 0) + (progress?.skip ?? 0);

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <s-heading>正在自动写回 Alt Text…</s-heading>

          {/* 进度条 */}
          <div className={styles.progressContainer}>
            <div className={styles.progressBarTrack}>
              <div
                className={`${styles.progressBarFill} ${
                  percent >= 100 ? styles.progressBarFillComplete : ""
                }`}
                style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
              />
            </div>
            <div className={styles.progressCount}>
              <s-text tone="neutral">
                {connected ? "已连接" : "连接中…"}
              </s-text>
              <s-text>
                {done} / {total} 已完成
              </s-text>
            </div>
          </div>

          {/* 成功计数 */}
          {progress && progress.success > 0 && (
            <s-text tone="success">
              {progress.success} 张图片写回成功
            </s-text>
          )}

          {/* 失败计数 */}
          {progress && progress.fail > 0 && (
            <s-text tone="critical">
              {progress.fail} 张图片写回失败
            </s-text>
          )}

          {/* 跳过计数 */}
          {progress && progress.skip > 0 && (
            <s-text tone="caution">
              {progress.skip} 张图片已跳过（已有 Alt Text）
            </s-text>
          )}

          {/* 错误信息 */}
          {error && (
            <s-box padding="base" borderRadius="base" background="strong">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          )}

          {/* 处理中提示 */}
          {!error && percent < 100 && (
            <s-text tone="neutral">
              正在将生成的 Alt Text 写回 Shopify，请勿关闭此页面。
            </s-text>
          )}
        </s-stack>
      </div>
    </div>
  );
}

// ============================================================================
// 完成汇总 Modal
// ============================================================================

interface SummaryModalProps {
  summary: GenerationSummary | null;
  totalCount: number;
  onClose: () => void;
}

function SummaryModal({ summary, totalCount, onClose }: SummaryModalProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const succeeded = summary?.succeeded ?? 0;
  const skipped = summary?.skipped ?? 0;
  const failed = summary?.failed ?? 0;
  const writeback = summary?.writeback ?? null;
  const writebackError = summary?.writebackError ?? null;
  const allSuccess = failed === 0 && skipped === 0;

  const handleViewHistory = () => {
    navigate(buildAppPath("/app/history", location.search));
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <div className={styles.modalHeader}>
            <s-heading>{allSuccess && !writebackError && (writeback === null || writeback.fail === 0) ? "生成完成！" : "生成已结束"}</s-heading>
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
            >
              ×
            </button>
          </div>

          {/* 生成汇总统计卡片 */}
          <s-text tone="neutral">生成结果</s-text>
          <div className={styles.summaryStats}>
            <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
              <span className={`${styles.statNumber} ${styles.statNumberSuccess}`}>
                {succeeded}
              </span>
              <span className={styles.statLabel}>成功</span>
            </div>
            <div className={`${styles.statCard} ${styles.statCardCaution}`}>
              <span className={`${styles.statNumber} ${styles.statNumberCaution}`}>
                {skipped}
              </span>
              <span className={styles.statLabel}>跳过（已有 Alt）</span>
            </div>
            <div className={`${styles.statCard} ${styles.statCardCritical}`}>
              <span className={`${styles.statNumber} ${styles.statNumberCritical}`}>
                {failed}
              </span>
              <span className={styles.statLabel}>失败</span>
            </div>
          </div>

          {/* 自动写回结果 */}
          {writeback ? (
            <>
              <s-text tone="neutral">自动写回结果</s-text>
              <div className={styles.summaryStats}>
                <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
                  <span className={`${styles.statNumber} ${styles.statNumberSuccess}`}>
                    {writeback.success}
                  </span>
                  <span className={styles.statLabel}>写回成功</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardCaution}`}>
                  <span className={`${styles.statNumber} ${styles.statNumberCaution}`}>
                    {writeback.skip}
                  </span>
                  <span className={styles.statLabel}>跳过（已有 Alt）</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardCritical}`}>
                  <span className={`${styles.statNumber} ${styles.statNumberCritical}`}>
                    {writeback.fail}
                  </span>
                  <span className={styles.statLabel}>写回失败</span>
                </div>
              </div>
            </>
          ) : writebackError ? (
            <s-text tone="critical">
              自动写回未能启动（{writebackError}），已生成的草稿保留，稍后可重新生成或查看历史。
            </s-text>
          ) : (
            <s-text tone="neutral">
              本次无成功生成项，无需写回。
            </s-text>
          )}

          {/* 失败提示 */}
          {failed > 0 && (
            <s-text tone="neutral">
              生成失败的图片可返回候选列表重新选择生成。
            </s-text>
          )}
          {writeback && writeback.fail > 0 && (
            <s-text tone="neutral">
              写回失败明细请前往写回历史查看。
            </s-text>
          )}

          {/* 操作按钮 */}
          <div className={styles.actions}>
            <div
              onClick={onClose}
              style={{ display: "inline-block", cursor: "pointer" }}
            >
              <s-button variant="secondary" accessibilityLabel="返回候选列表">
                返回候选列表
              </s-button>
            </div>
            <div
              onClick={handleViewHistory}
              style={{ display: "inline-block", cursor: "pointer" }}
            >
              <s-button variant="primary" accessibilityLabel="查看写回历史">
                查看写回历史
              </s-button>
            </div>
          </div>
        </s-stack>
      </div>
    </div>
  );
}
