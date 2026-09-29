/**
 * File: app/components/generation/TruthCheckDebugModal.tsx
 * Purpose: 写回真值复核调试弹窗（调试专用，仅 WRITEBACK_TRUTH_DEBUG=true 时有数据）。
 *          写回进行期间实时展示每条真值复核结果（复核到的线上当前 Alt、判定动作），
 *          供人工对照 Shopify 后台确认真值复核是否正确。
 *          收到首条事件自动弹出；用户关闭后本次写回期间不再自动弹出。
 *          居中 Modal，叠加在写回进度浮层之上。
 */
import { useState } from "react";
import styles from "./GenerationFlow.module.css";
import type { WritebackTruthDebugEvent } from "../../hooks/useWritebackTruthDebug";

/** AltPlane 枚举的中文标签 */
const ALT_PLANE_LABELS: Record<string, string> = {
  FILE_ALT: "商品图片",
  COLLECTION_IMAGE_ALT: "集合图片",
  ARTICLE_IMAGE_ALT: "文章图片",
};

/** 处置动作的展示文案 */
const ACTION_LABELS: Record<WritebackTruthDebugEvent["action"], string> = {
  WRITE: "判定缺失 → 将写回",
  ALREADY_WRITTEN_BY_SELF: "判定已填充，但与本应用待写文本一致 → 记为写回成功",
  SKIP_ALREADY_FILLED: "判定已填充 → 跳过",
};

/** GID 末段截短显示（如 gid://shopify/MediaImage/123 → MediaImage/123） */
function shortenGid(gid: string): string {
  const segments = gid.split("/");
  return segments.slice(-2).join("/");
}

/** currentAlt 展示截断长度 */
const ALT_PREVIEW_MAX_LENGTH = 80;

/** 候选 ID 尾段，用于同一目标多次写回时区分事件 */
function shortenCandidateId(candidateId: string): string {
  return candidateId.slice(-6);
}

/** 截断过长的 Alt Text 预览 */
function truncateAlt(alt: string): string {
  return alt.length > ALT_PREVIEW_MAX_LENGTH
    ? `${alt.slice(0, ALT_PREVIEW_MAX_LENGTH)}…`
    : alt;
}

interface TruthCheckDebugModalProps {
  /** 已收到的复核结果事件（按到达顺序） */
  events: WritebackTruthDebugEvent[];
  /** 调试 SSE 是否已连接 */
  connected: boolean;
}

export function TruthCheckDebugModal({
  events,
  connected,
}: TruthCheckDebugModalProps) {
  // 用户关闭后本次写回期间不再自动弹出（事件仍在父层继续累积，但弹窗不再展示）
  const [dismissed, setDismissed] = useState(false);

  // 未收到任何事件（或调试开关关闭）时不渲染，避免空弹窗打扰
  if (events.length === 0 || dismissed) {
    return null;
  }

  // 最新事件排在最上，便于实时查看
  const orderedEvents = [...events].reverse();

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <s-stack direction="block" gap="base">
          <div className={styles.modalHeader}>
            <s-stack direction="block" gap="none">
              <s-heading>真值复核调试（写回链路）</s-heading>
              <s-text tone="neutral">
                {connected ? "已连接，实时接收复核结果" : "连接中…"} ·
                共 {events.length} 条 · 请对照 Shopify 后台该图片的实际 Alt Text 核对
              </s-text>
            </s-stack>
            <button
              type="button"
              className={styles.closeButton}
              onClick={() => setDismissed(true)}
              aria-label="关闭"
              title="关闭"
            >
              ×
            </button>
          </div>

          <s-text tone="neutral">
            「复核到的当前 Alt」是本应用从 Shopify 线上读回的值；
            若与 Shopify 后台显示的 Alt Text 不一致，说明真值复核存在问题。
          </s-text>

          <div className={styles.truthDebugList}>
            {orderedEvents.map((event, index) => {
              const isSkip = event.action === "SKIP_ALREADY_FILLED";
              return (
                <div
                  key={`${event.candidateId}-${event.checkedAt}-${index}`}
                  className={styles.truthDebugItem}
                >
                  <div className={styles.truthDebugMeta}>
                    <span>
                      {new Date(event.checkedAt).toLocaleTimeString()}
                    </span>
                    <span>
                      {ALT_PLANE_LABELS[event.altPlane] ?? event.altPlane} ·{" "}
                      {shortenGid(event.writeTargetId)} · 候选{" "}
                      {shortenCandidateId(event.candidateId)}
                    </span>
                    {event.attempt > 1 && (
                      <span className={styles.truthDebugDeleted}>
                        第 {event.attempt} 次执行
                      </span>
                    )}
                    {event.isDeleted && <span className={styles.truthDebugDeleted}>资源已删除</span>}
                  </div>

                  <div
                    className={`${styles.truthDebugAction} ${
                      isSkip ? styles.truthDebugActionSkip : styles.truthDebugActionWrite
                    }`}
                  >
                    {ACTION_LABELS[event.action]}
                    {isSkip && "（商家已手动补 Alt）"}
                  </div>

                  <div className={styles.truthDebugAlt}>
                    复核到的当前 Alt：
                    {event.currentAlt === null ? (
                      <span className={styles.truthDebugAltEmpty}>（空 / null）</span>
                    ) : (
                      <span>
                        「{truncateAlt(event.currentAlt)}」
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </s-stack>
      </div>
    </div>
  );
}
