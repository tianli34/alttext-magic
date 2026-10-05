/**
 * File: app/components/generation/GenerationFlow.tsx
 * Purpose: 生成触发交互流程组件。
 *          包含预检确认 Modal、生成进度展示浮层、自动写回进度展示浮层、完成汇总 Modal。
 *          生成/写回/启动阶段为左侧固定浮层（无遮罩，停靠在仪表盘左侧留白，不与仪表盘重叠；
 *          任何视口宽度下均保持左侧停靠）；确认与汇总为居中 Modal。
 *          由外部传入 useGenerationFlow 返回值驱动渲染。
 */
import { useLocation, useNavigate } from "react-router";
import type { ReactNode, RefObject } from "react";
import styles from "./GenerationFlow.module.css";
import { buildAppPath } from "../../lib/app-navigation";
import {
  SIDE_PANEL_EDGE_INSET,
  SIDE_PANEL_WIDTH,
} from "../../hooks/useSidePanelRail";
import type {
  GenerationFlowPhase,
  PreflightResult,
  GenerationSummary,
} from "../../hooks/useGenerationFlow";
import type { GenerationProgressData } from "../../hooks/useGenerationSSE";
import type { WritebackProgressData } from "../../hooks/useWritebackSSE";
import type { WritebackTruthDebugEvent } from "../../hooks/useWritebackTruthDebug";
import { TruthCheckDebugModal } from "./TruthCheckDebugModal";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 「未知」计数占位符。
 * 生成侧计数（成功/跳过/失败）是派生量而非服务端权威字段，
 * 刷新恢复路径回填失败时该值不存在，必须以此占位，不得兜底成 0。
 */
const UNKNOWN_COUNT_PLACEHOLDER = "—";

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
  /** 真值复核调试事件（仅 WRITEBACK_TRUTH_DEBUG=true 时有数据，调试专用） */
  truthDebugEvents: WritebackTruthDebugEvent[];
  /** 真值复核调试 SSE 是否已连接 */
  truthDebugConnected: boolean;
  /** 左侧浮层宽度（px，已按仪表盘左侧可用留白收敛，由 useSidePanelRail 计算） */
  sidePanelWidth?: number;
  /** 浮层元素 ref：供 useSidePanelRail 实测真实右边缘做闭环校正 */
  sidePanelRef?: RefObject<HTMLDivElement>;
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
  truthDebugEvents,
  truthDebugConnected,
  sidePanelWidth = SIDE_PANEL_WIDTH,
  sidePanelRef,
  onConfirmAndStart,
  onCancel,
  onCloseSummary,
}: GenerationFlowProps) {
  if (phase === "IDLE") {
    return null;
  }

  if (phase === "PREFLIGHT_LOADING") {
    return <QuickProcessPrepareModal error={error} onCancel={onCancel} />;
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
      <SidePanel width={sidePanelWidth} panelRef={sidePanelRef}>
        <s-stack direction="block" gap="base">
          <s-heading>正在启动生成…</s-heading>
          <s-text tone="neutral">正在准备生成任务，请稍候。</s-text>
        </s-stack>
      </SidePanel>
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
        width={sidePanelWidth}
        panelRef={sidePanelRef}
      />
    );
  }

  if (phase === "WRITEBACK") {
    return (
      <>
        <WritebackProgressView
          progress={writebackProgress}
          connected={writebackConnected}
          percent={writebackPercent}
          error={writebackError}
          width={sidePanelWidth}
          panelRef={sidePanelRef}
        />
        {/* 调试弹窗：实时展示写回链路的真值复核结果（无事件/已关闭/开关关闭时不渲染） */}
        <TruthCheckDebugModal events={truthDebugEvents} connected={truthDebugConnected} />
      </>
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
// 左侧浮层容器（启动/生成/写回进度：无遮罩，停靠在仪表盘左侧留白）
// ============================================================================

interface SidePanelProps {
  /** 浮层宽度（px），已按仪表盘左侧可用留白收敛 */
  width: number;
  /** 浮层元素 ref（供调用方实测真实右边缘做闭环校正） */
  panelRef?: RefObject<HTMLDivElement>;
  children: ReactNode;
}

function SidePanel({ width, panelRef, children }: SidePanelProps) {
  return (
    <div
      ref={panelRef}
      className={styles.sidePanel}
      style={{ left: SIDE_PANEL_EDGE_INSET, width }}
    >
      {children}
    </div>
  );
}

// ============================================================================
// 一键处理准备 Modal（统计候选 ID 期间的占位弹窗；统计失败/无候选时展示错误）
// ============================================================================

interface QuickProcessPrepareModalProps {
  /** 统计失败或无候选时的错误信息（null 表示仍在统计中） */
  error: string | null;
  /** 关闭弹窗（回到 IDLE） */
  onCancel: () => void;
}

function QuickProcessPrepareModal({ error, onCancel }: QuickProcessPrepareModalProps) {
  // 统计进行中不提供关闭入口：避免关闭后请求返回再次拉起弹窗造成状态混乱
  if (!error) {
    return (
      <div className={styles.overlay}>
        <div className={styles.modal}>
          <s-stack direction="block" gap="base">
            <s-heading>一键处理</s-heading>
            <s-text tone="neutral">正在统计待处理图片…</s-text>
          </s-stack>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <s-stack direction="block" gap="base">
          <s-heading>一键处理</s-heading>
          <s-box padding="base" borderRadius="base" background="strong">
            <s-text tone="critical">{error}</s-text>
          </s-box>
          <div className={styles.actions}>
            <div onClick={onCancel} style={{ display: "inline-block", cursor: "pointer" }}>
              <s-button variant="secondary" accessibilityLabel="关闭">
                关闭
              </s-button>
            </div>
          </div>
        </s-stack>
      </div>
    </div>
  );
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
  /** 浮层宽度（px） */
  width: number;
  /** 浮层元素 ref（供调用方实测真实右边缘做闭环校正） */
  panelRef?: RefObject<HTMLDivElement>;
}

function ProgressModal({
  totalCount,
  progress,
  connected,
  percent,
  error,
  width,
  panelRef,
}: ProgressModalProps) {
  const current = progress?.current ?? 0;
  const total = progress?.total ?? totalCount;

  return (
    <SidePanel width={width} panelRef={panelRef}>
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
    </SidePanel>
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
  /** 浮层宽度（px） */
  width: number;
  /** 浮层元素 ref（供调用方实测真实右边缘做闭环校正） */
  panelRef?: RefObject<HTMLDivElement>;
}

function WritebackProgressView({
  progress,
  connected,
  percent,
  error,
  width,
  panelRef,
}: WritebackProgressViewProps) {
  const total = progress?.total ?? 0;
  const done = (progress?.success ?? 0) + (progress?.fail ?? 0) + (progress?.skip ?? 0);

  return (
    <SidePanel width={width} panelRef={panelRef}>
      <s-stack direction="block" gap="base">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <s-heading>正在自动写回 Alt Text…</s-heading>
          <s-box padding="small" borderRadius="base" background="subdued">
            <s-text tone="success">✓ 对齐已应用</s-text>
          </s-box>
        </div>

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
    </SidePanel>
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
  // 生成计数为派生量：刷新恢复路径回填失败时为 null，必须以占位符呈现，
  // 不得兜底成 0（否则会出现「生成成功 0 / 写回成功 94」这种自相矛盾的汇总）
  const succeeded = summary?.succeeded ?? null;
  const skipped = summary?.skipped ?? null;
  const failed = summary?.failed ?? null;
  // 「仅写回」的一键处理（无生成候选）全程没有生成阶段：生成侧三项本就不存在，
  // 既不渲染生成结果卡片，也不显示「计数未能取得」提示
  const generationRan = summary?.generationRan ?? true;
  const generationCountUnknown =
    generationRan && (succeeded === null || skipped === null || failed === null);
  const writeback = summary?.writeback ?? null;
  const writebackError = summary?.writebackError ?? null;
  // 未运行生成阶段时不以生成侧计数判定成败：那三项恒为 null，
  // 若沿用原判定，写回全部成功的「仅写回」流程会被拖成「已结束」
  const generationAllSuccess = !generationRan || (failed === 0 && skipped === 0);
  const allSuccess =
    generationAllSuccess && !writebackError && (writeback === null || writeback.fail === 0);
  const heading = allSuccess
    ? generationRan
      ? "生成完成！"
      : "写回完成！"
    : generationRan
      ? "生成已结束"
      : "写回已结束";

  const handleViewHistory = () => {
    navigate(buildAppPath("/app/history", location.search));
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <div className={styles.modalHeader}>
            <s-heading>{heading}</s-heading>
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

          {/* 生成汇总统计卡片（仅写回的一键处理没有生成阶段，整段不渲染） */}
          {generationRan && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <s-text tone="neutral">生成结果</s-text>
                <s-box padding="small" borderRadius="base" background="subdued">
                  <s-text tone="success">✓ 计数对齐已应用</s-text>
                </s-box>
              </div>
              <div className={styles.summaryStats}>
                <div className={`${styles.statCard} ${styles.statCardSuccess}`}>
                  <span className={`${styles.statNumber} ${styles.statNumberSuccess}`}>
                    {succeeded ?? UNKNOWN_COUNT_PLACEHOLDER}
                  </span>
                  <span className={styles.statLabel}>成功</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardCaution}`}>
                  <span className={`${styles.statNumber} ${styles.statNumberCaution}`}>
                    {skipped ?? UNKNOWN_COUNT_PLACEHOLDER}
                  </span>
                  <span className={styles.statLabel}>跳过（已有 Alt）</span>
                </div>
                <div className={`${styles.statCard} ${styles.statCardCritical}`}>
                  <span className={`${styles.statNumber} ${styles.statNumberCritical}`}>
                    {failed ?? UNKNOWN_COUNT_PLACEHOLDER}
                  </span>
                  <span className={styles.statLabel}>失败</span>
                </div>
              </div>

              {/* 计数未知提示：刷新恢复路径回填失败时，生成侧计数以占位符呈现，明确标注而非显示 0 */}
              {generationCountUnknown && (
                <s-text tone="neutral">
                  生成阶段计数未能取得（{UNKNOWN_COUNT_PLACEHOLDER}），请以候选列表与写回历史为准。
                </s-text>
              )}
            </>
          )}

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
          {(failed ?? 0) > 0 && (
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
