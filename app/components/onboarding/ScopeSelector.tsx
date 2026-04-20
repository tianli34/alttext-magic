/**
 * File: app/components/onboarding/ScopeSelector.tsx
 * Purpose: 首次扫描说明页中的 scope 勾选器。
 *          展示四类图片资源，允许用户勾选/取消需要扫描的类型。
 *
 * 注意：本项目使用 Polaris Web Components (Shadow DOM)，自定义样式通过
 *       HTML style 属性注入，s-text/s-heading 等组件仅支持有限的
 *       React props（id、children、tone 等特定属性）。
 */
import { useCallback } from "react";
import {
  type ScopeFlag,
  type ScopeFlagState,
  SCOPE_FLAG_ORDER,
} from "../../lib/scope-utils";

/** scope flag 到中文标签的映射 */
const SCOPE_LABELS: Record<ScopeFlag, string> = {
  PRODUCT_MEDIA: "产品媒体",
  FILES: "文件库图片",
  COLLECTION_IMAGE: "集合封面图",
  ARTICLE_IMAGE: "文章封面图",
};

/** scope flag 到描述的映射 */
const SCOPE_DESCRIPTIONS: Record<ScopeFlag, string> = {
  PRODUCT_MEDIA: "产品页面的所有图片与媒体文件",
  FILES: "店铺文件库中上传的通用素材与营销图",
  COLLECTION_IMAGE: "各集合的横幅与封面图片",
  ARTICLE_IMAGE: "博客文章的封面图片",
};

export interface ScopeSelectorProps {
  /** 当前 scope 状态 */
  scopeFlags: ScopeFlagState;
  /** scope 状态变更回调 */
  onChange: (flags: ScopeFlagState) => void;
  /** 是否禁用交互 */
  disabled?: boolean;
}

export function ScopeSelector({
  scopeFlags,
  onChange,
  disabled = false,
}: ScopeSelectorProps) {
  const handleToggle = useCallback(
    (flag: ScopeFlag) => {
      onChange({
        ...scopeFlags,
        [flag]: !scopeFlags[flag],
      });
    },
    [scopeFlags, onChange],
  );

  const handleSelectAll = useCallback(() => {
    onChange({
      PRODUCT_MEDIA: true,
      FILES: true,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: true,
    });
  }, [onChange]);

  const handleDeselectAll = useCallback(() => {
    onChange({
      PRODUCT_MEDIA: false,
      FILES: false,
      COLLECTION_IMAGE: false,
      ARTICLE_IMAGE: false,
    });
  }, [onChange]);

  const enabledCount = SCOPE_FLAG_ORDER.filter(
    (flag) => scopeFlags[flag],
  ).length;
  const hasAnySelected = enabledCount > 0;

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        {/* 标题行 */}
        <s-stack direction="block" gap="small">
          <s-heading>扫描范围</s-heading>
          <s-text tone="neutral">
            （已选 {enabledCount}/{SCOPE_FLAG_ORDER.length}）
          </s-text>
        </s-stack>

        <s-text>选择您希望扫描的图片类型。默认全部选中。</s-text>

        {/* 全选/取消全选快捷操作 */}
        <s-stack direction="inline" gap="small">
          <s-button
            variant="tertiary"
            onClick={handleSelectAll}
            disabled={disabled}
            accessibilityLabel="全选"
          >
            全选
          </s-button>
          <s-button
            variant="tertiary"
            onClick={handleDeselectAll}
            disabled={disabled}
            accessibilityLabel="取消全选"
          >
            取消全选
          </s-button>
        </s-stack>

        {/* 各 scope 勾选项 */}
        <s-stack direction="block" gap="small">
          {SCOPE_FLAG_ORDER.map((flag) => (
            <s-box
              key={flag}
              padding="small"
              borderWidth="base"
              borderRadius="base"
              background={scopeFlags[flag] ? "subdued" : "base"}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={scopeFlags[flag]}
                  onChange={() => handleToggle(flag)}
                  disabled={disabled}
                  style={{ minWidth: "1rem", minHeight: "1rem" }}
                />
                <div>
                  <strong>{SCOPE_LABELS[flag]}</strong>
                  <br />
                  <span style={{ fontSize: "0.85em", color: "#6d7175" }}>
                    {SCOPE_DESCRIPTIONS[flag]}
                  </span>
                </div>
              </label>
            </s-box>
          ))}
        </s-stack>

        {/* 未选择任何 scope 时的提示 */}
        {!hasAnySelected && (
          <s-box padding="small" background="subdued" borderRadius="base">
            <s-text tone="warning">请至少选择一个图片类型，否则无法开始扫描。</s-text>
          </s-box>
        )}
      </s-stack>
    </s-box>
  );
}
