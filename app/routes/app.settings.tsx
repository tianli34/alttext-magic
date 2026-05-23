import { useState, useEffect, useCallback } from "react";
import type { ScopeFlagState } from "../lib/scope-utils";
import { SCOPE_FLAG_ORDER } from "../lib/scope-utils";

interface ScopeSettings {
  scanScopeFlags: ScopeFlagState;
  lastPublishedScopeFlags: ScopeFlagState | null;
  effectiveReadScopeFlags: ScopeFlagState;
}

interface PlanInfo {
  planKey: string;
  displayName: string;
  monthlyQuota: number;
  incrementalScanEnabled: boolean;
}

interface HelpLinks {
  faq: string;
  contact: string;
  docs: string;
}

interface SettingsData {
  scopes: ScopeSettings;
  plan: PlanInfo;
  helpLinks: HelpLinks;
}

const SCOPE_LABELS: Record<string, string> = {
  PRODUCT_MEDIA: "产品媒体",
  FILES: "文件库图片",
  COLLECTION_IMAGE: "集合封面图",
  ARTICLE_IMAGE: "文章封面图",
};

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  PRODUCT_MEDIA: "产品页面的所有图片与媒体文件",
  FILES: "店铺文件库中上传的通用素材与营销图",
  COLLECTION_IMAGE: "各集合的横幅与封面图片",
  ARTICLE_IMAGE: "博客文章的封面图片",
};

export default function AppSettingsPage() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [scopeFlags, setScopeFlags] = useState<ScopeFlagState | null>(null);
  const [originalScopeFlags, setOriginalScopeFlags] = useState<ScopeFlagState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setFetchError(null);
      try {
        const res = await fetch("/api/settings", { signal: controller.signal });
        if (!res.ok) throw new Error(`请求失败 (${res.status})`);
        const data = await res.json() as SettingsData;
        setSettings(data);
        setScopeFlags(data.scopes.scanScopeFlags);
        setOriginalScopeFlags(data.scopes.scanScopeFlags);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFetchError(err instanceof Error ? err.message : "加载失败");
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  const handleToggle = useCallback((flag: string) => {
    setScopeFlags((prev) => prev ? { ...prev, [flag]: !prev[flag as keyof ScopeFlagState] } : prev);
  }, []);

  const hasChanges = scopeFlags && originalScopeFlags &&
    SCOPE_FLAG_ORDER.some((f) => scopeFlags[f] !== originalScopeFlags[f]);

  const handleSave = useCallback(async () => {
    if (!scopeFlags || !hasChanges) return;
    setSaving(true);
    setSaveError(null);

    try {
      const res = await fetch("/api/settings/scopes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          products: scopeFlags.PRODUCT_MEDIA,
          files: scopeFlags.FILES,
          collections: scopeFlags.COLLECTION_IMAGE,
          articles: scopeFlags.ARTICLE_IMAGE,
        }),
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setSaveError(body.error ?? `保存失败 (${res.status})`);
        setSaving(false);
        return;
      }

      setOriginalScopeFlags({ ...scopeFlags });
      setToastMessage("扫描范围已更新");
      setTimeout(() => setToastMessage(null), 3000);
    } catch {
      setSaveError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  }, [scopeFlags, hasChanges]);

  if (loading) {
    return (
      <s-page heading="Settings">
        <s-section heading="设置">
          <s-box padding="base" borderRadius="base" background="subdued" borderWidth="base">
            <s-text tone="neutral">正在加载设置…</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  if (fetchError) {
    return (
      <s-page heading="Settings">
        <s-section heading="设置">
          <s-box padding="base" borderRadius="base" background="strong">
            <s-text tone="critical">{fetchError}</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  if (!settings || !scopeFlags) return null;

  const enabledCount = SCOPE_FLAG_ORDER.filter((f) => scopeFlags[f]).length;

  const saveButtonDisabled = !hasChanges || saving;
  const saveButtonStyle: React.CSSProperties = {
    padding: "0.625rem 1rem",
    border: "none",
    borderRadius: "0.75rem",
    background: saveButtonDisabled
      ? "var(--p-color-bg-fill-disabled)"
      : "var(--p-color-bg-fill-brand)",
    color: saveButtonDisabled
      ? "var(--p-color-text-disabled)"
      : "var(--p-color-text-brand-on-bg-fill)",
    font: "inherit",
    fontWeight: 600,
    cursor: saveButtonDisabled ? "not-allowed" : "pointer",
  };

  return (
    <s-page heading="Settings">
      {toastMessage && <s-toast content={toastMessage} />}

      {/* ── 扫描范围 ── */}
      <s-section heading="扫描范围">
        <s-stack direction="block" gap="base">
          <s-text>选择当前店铺希望扫描的图片类型。修改后保存即可生效，无需重新扫描。</s-text>

          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="small">
                <s-text tone="neutral">已选 {enabledCount}/{SCOPE_FLAG_ORDER.length}</s-text>
              </s-stack>

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
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={scopeFlags[flag]}
                        onChange={() => handleToggle(flag)}
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
            </s-stack>
          </s-box>

          <s-stack direction="inline" gap="base">
            <button
              type="button"
              onClick={handleSave}
              disabled={saveButtonDisabled}
              style={saveButtonStyle}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {hasChanges && (
              <s-text tone="neutral">有未保存的更改</s-text>
            )}
          </s-stack>

          {saveError && (
            <s-box padding="small" borderRadius="base" background="strong">
              <s-text tone="critical">{saveError}</s-text>
            </s-box>
          )}
        </s-stack>
      </s-section>

      {/* ── 当前计划 ── */}
      <s-section heading="当前计划">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small">
              <s-text tone="neutral">计划：</s-text>
              <s-text><strong>{settings.plan.displayName}</strong></s-text>
            </s-stack>

            <s-stack direction="inline" gap="small">
              <s-text tone="neutral">月额度：</s-text>
              <s-text>{settings.plan.monthlyQuota} 条</s-text>
            </s-stack>

            <s-stack direction="inline" gap="small">
              <s-text tone="neutral">增量扫描：</s-text>
              <s-text>{settings.plan.incrementalScanEnabled ? "已启用" : "未启用"}</s-text>
            </s-stack>

            <s-stack direction="inline" gap="small">
              <a
                href="/app/billing"
                style={{
                  color: "var(--p-color-text-link)",
                  textDecoration: "underline",
                  cursor: "pointer",
                }}
              >
                升级计划 →
              </a>
            </s-stack>
          </s-stack>
        </s-box>
      </s-section>

      {/* ── 帮助与支持 ── */}
      <s-section heading="帮助与支持">
        <s-box padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="small">
            <a
              href={settings.helpLinks.faq}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "var(--p-color-text-link)",
                textDecoration: "underline",
              }}
            >
              常见问题 (FAQ)
            </a>
            <a
              href={settings.helpLinks.contact}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "var(--p-color-text-link)",
                textDecoration: "underline",
              }}
            >
              联系我们
            </a>
            <a
              href={settings.helpLinks.docs}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                color: "var(--p-color-text-link)",
                textDecoration: "underline",
              }}
            >
              使用文档
            </a>
          </s-stack>
        </s-box>
      </s-section>
    </s-page>
  );
}
