/**
 * File: app/components/review/WritebackConfirmModal.tsx
 * Purpose: 写回二次确认弹窗。
 *          展示选中数量、图片类型分布、共享文件警告，确认后调用写回 API。
 */
import { useCallback, useMemo } from "react";
import styles from "./WritebackConfirmModal.module.css";

// ============================================================================
// 类型定义
// ============================================================================

type AltPlane = "FILE_ALT" | "COLLECTION_IMAGE_ALT" | "ARTICLE_IMAGE_ALT";

export interface WritebackConfirmItem {
  candidateId: string;
  altPlane: AltPlane;
  isSharedFile: boolean;
  usageCountPresent: number;
}

export interface WritebackConfirmModalProps {
  /** 是否打开弹窗 */
  open: boolean;
  /** 选中的候选项列表 */
  selectedItems: WritebackConfirmItem[];
  /** 是否正在提交 */
  loading: boolean;
  /** 确认写回回调 */
  onConfirm: () => void;
  /** 取消/关闭回调 */
  onCancel: () => void;
}

// ============================================================================
// 常量
// ============================================================================

const ALT_PLANE_LABELS: Record<AltPlane, string> = {
  FILE_ALT: "文件图片",
  COLLECTION_IMAGE_ALT: "集合封面",
  ARTICLE_IMAGE_ALT: "文章封面",
};

// ============================================================================
// 组件
// ============================================================================

export function WritebackConfirmModal({
  open,
  selectedItems,
  loading,
  onConfirm,
  onCancel,
}: WritebackConfirmModalProps) {
  /** 按类型分组统计 */
  const typeDistribution = useMemo(() => {
    const map = new Map<AltPlane, number>();
    for (const item of selectedItems) {
      map.set(item.altPlane, (map.get(item.altPlane) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([altPlane, count]) => ({
      altPlane,
      label: ALT_PLANE_LABELS[altPlane],
      count,
    }));
  }, [selectedItems]);

  /** 共享文件项（FILE_ALT 且 usageCountPresent > 1） */
  const sharedFileItems = useMemo(
    () => selectedItems.filter((item) => item.isSharedFile),
    [selectedItems],
  );
  const sharedFileCount = sharedFileItems.length;
  const hasSharedFiles = sharedFileCount > 0;

  /** ESC 关闭 */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape" && !loading) {
        onCancel();
      }
    },
    [loading, onCancel],
  );

  if (!open) return null;

  const totalCount = selectedItems.length;

  return (
    <div className={styles.overlay} onClick={loading ? undefined : onCancel} onKeyDown={handleKeyDown}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="writeback-confirm-title">
        <s-stack direction="block" gap="base">
          {/* 标题 */}
          <s-heading id="writeback-confirm-title">确认写回</s-heading>

          {/* 选中数量 */}
          <s-text>
            即将写回 <strong>{totalCount}</strong> 张图片的 Alt Text。
          </s-text>

          {/* 图片类型分布列表 */}
          <div className={styles.distributionBox}>
            <s-stack direction="block" gap="small">
              {typeDistribution.map(({ altPlane, label, count }) => (
                <div key={altPlane} className={styles.distributionRow}>
                  <span className={styles.typeLabel}>{label}</span>
                  <span className={styles.typeCount}>{count} 张</span>
                </div>
              ))}
            </s-stack>
          </div>

          {/* 共享文件全局影响警告 */}
          {hasSharedFiles && (
            <div className={styles.sharedBanner}>
              <span className={styles.sharedBannerIcon} aria-hidden="true">!</span>
              <s-text>
                其中 <strong>{sharedFileCount}</strong> 张文件图片在多个位置使用，写回将影响所有引用位置。标识：SHARED_NEUTRAL
              </s-text>
            </div>
          )}

          {/* 操作按钮 */}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cancelButton}
              disabled={loading}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className={styles.confirmButton}
              disabled={loading}
              onClick={onConfirm}
            >
              {loading ? "提交中..." : "确认写回"}
            </button>
          </div>
        </s-stack>
      </div>
    </div>
  );
}
