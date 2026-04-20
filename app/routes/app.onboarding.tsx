/**
 * File: app/routes/app.onboarding.tsx
 * Purpose: 首次扫描说明页路由。
 *          当 bootstrap 返回 needsNoticeAck=true 时展示此页面。
 *          用户阅读说明 → 勾选 scope → 确认 → 提交 scan/start → 跳转进度页。
 */
import { useState, useCallback } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getBootstrapData } from "../../server/modules/bootstrap/bootstrap.service";
import { ScanNotice } from "../components/onboarding/ScanNotice";
import { ScopeSelector } from "../components/onboarding/ScopeSelector";
import {
  type ScopeFlagState,
  DEFAULT_SCOPE_FLAG_STATE,
  listEnabledScopeFlags,
} from "../lib/scope-utils";
import { SCAN_NOTICE_VERSION } from "../../server/config/constants";

/** Bootstrap 数据类型（前端需要的子集） */
interface OnboardingLoaderData {
  needsNoticeAck: boolean;
  noticeVersion: string;
  scanScopeFlags: ScopeFlagState;
}

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

  // 如果不需要确认说明页，直接重定向到首页
  if (!bootstrap.needsNoticeAck) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/app" },
    });
  }

  return Response.json({
    needsNoticeAck: bootstrap.needsNoticeAck,
    noticeVersion: bootstrap.noticeVersion,
    scanScopeFlags: bootstrap.scanScopeFlags,
  });
};

export default function OnboardingPage() {
  const loaderData = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const { noticeVersion, scanScopeFlags } = loaderData as OnboardingLoaderData;

  // scope 勾选状态，初始使用 bootstrap 返回的当前配置
  const [scopeFlags, setScopeFlags] = useState<ScopeFlagState>(
    scanScopeFlags ?? DEFAULT_SCOPE_FLAG_STATE,
  );

  // 是否确认阅读说明
  const [acknowledged, setAcknowledged] = useState(false);

  // 提交中状态
  const [submitting, setSubmitting] = useState(false);

  // 错误信息
  const [error, setError] = useState<string | null>(null);

  // 是否至少选择了一个 scope
  const hasAnyScope = listEnabledScopeFlags(scopeFlags).length > 0;

  // 是否可以提交
  const canSubmit = acknowledged && hasAnyScope && !submitting;

  const handleScopeChange = useCallback((flags: ScopeFlagState) => {
    setScopeFlags(flags);
  }, []);

  const handleAcknowledgeChange = useCallback((ack: boolean) => {
    setAcknowledged(ack);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/scan/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...scopeFlags,
          noticeVersion: noticeVersion || SCAN_NOTICE_VERSION,
        }),
      });

      if (!response.ok) {
        const data = await response.json() as { error?: string };
        setError(data.error ?? `请求失败 (${response.status})`);
        setSubmitting(false);
        return;
      }

      // 成功后跳转到首页（Dashboard 将展示扫描进度）
      navigate("/app");
    } catch {
      setError("网络错误，请稍后重试");
      setSubmitting(false);
    }
  }, [canSubmit, scopeFlags, noticeVersion, navigate]);

  return (
    <s-page heading="首次扫描说明">
      <s-section heading="开始前请先了解以下信息">
        <s-stack direction="block" gap="base">
          {/* 扫描说明内容 */}
          <ScanNotice
            acknowledged={acknowledged}
            onAcknowledgeChange={handleAcknowledgeChange}
          />

          {/* Scope 勾选器 */}
          <ScopeSelector
            scopeFlags={scopeFlags}
            onChange={handleScopeChange}
            disabled={submitting}
          />

          {/* 错误信息 */}
          {error && (
            <s-box padding="small" background="strong" borderRadius="base">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          )}

          {/* 校验提示 */}
          {!acknowledged && (
            <s-box padding="small" background="strong" borderRadius="base">
              <s-text tone="caution">请先阅读并确认以上说明后再开始扫描。</s-text>
            </s-box>
          )}
          {acknowledged && !hasAnyScope && (
            <s-box padding="small" background="strong" borderRadius="base">
              <s-text tone="caution">请至少选择一个图片类型。</s-text>
            </s-box>
          )}

          {/* 提交按钮 */}
          <s-stack direction="inline" gap="base">
            <s-button
              variant="primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
              accessibilityLabel="开始扫描"
            >
              {submitting ? "正在启动..." : "开始扫描"}
            </s-button>
            {submitting && (
              <s-text tone="neutral">正在创建扫描任务，请稍候...</s-text>
            )}
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
