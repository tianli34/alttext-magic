/**
 * 文件: app/routes/app.ai-stats.tsx
 * 用途: AI 模型调用统计页面 — 展示所有模型调用成功/失败次数、成功率、耗时等数据
 */
import { useEffect, useState, useCallback } from "react";
import { displayModelName } from "../lib/format";

interface StatusDuration {
  avgDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
}

interface OverallStats {
  total: number;
  success: number;
  failed: number;
  successRate: number;
  successDuration: StatusDuration;
  failedDuration: StatusDuration;
}

interface ModelStat {
  modelName: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  successDuration: StatusDuration;
  failedDuration: StatusDuration;
}

interface AiStatsResponse {
  overall: OverallStats;
  byModel: ModelStat[];
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}

function fmtPct(rate: number): string {
  return `${rate}%`;
}

function StatsCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "critical" | "caution" | "neutral";
}) {
  return (
    <s-box padding="base" borderRadius="base" borderWidth="base" background="subdued">
      <s-stack direction="block" gap="small">
        <span style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>
          {label}
        </span>
        <span
          style={{
            fontSize: "1.5rem",
            fontWeight: 600,
            color: tone
              ? `var(--p-color-text-${tone}, inherit)`
              : "inherit",
          }}
        >
          {value}
        </span>
      </s-stack>
    </s-box>
  );
}

export default function AppAiStatsPage() {
  const [data, setData] = useState<AiStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-stats");
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `请求失败 (${res.status})`);
      }
      const json = (await res.json()) as AiStatsResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载统计失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  if (loading && !data) {
    return (
      <s-page heading="AI 调用统计">
        <s-section heading="加载中">
          <s-box padding="base" borderRadius="base" borderWidth="base" background="subdued">
            <s-text tone="neutral">正在加载 AI 调用统计数据…</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  if (error && !data) {
    return (
      <s-page heading="AI 调用统计">
        <s-section heading="加载失败">
          <s-box padding="base" borderRadius="base" borderWidth="base" background="subdued">
            <s-stack direction="block" gap="base">
              <s-text tone="caution">{error}</s-text>
              <button
                type="button"
                onClick={fetchStats}
                style={{
                  display: "inline-block",
                  padding: "0.5rem 1rem",
                  border: "none",
                  borderRadius: "0.5rem",
                  background: "var(--p-color-bg-fill-brand, #008060)",
                  color: "var(--p-color-text-brand-on-bg-fill, #ffffff)",
                  font: "inherit",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                重试
              </button>
            </s-stack>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  if (!data) {
    return (
      <s-page heading="AI 调用统计">
        <s-section heading="暂无数据">
          <s-box padding="base" borderRadius="base" borderWidth="base" background="subdued">
            <s-text tone="neutral">暂无 AI 调用数据。</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  const { overall, byModel } = data;

  return (
    <s-page heading="AI 调用统计">
      {/* ---- 概览 ---- */}
      <s-section heading="总体概览">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
            gap: "16px",
          }}
        >
          <StatsCard label="总调用次数" value={overall.total.toLocaleString("zh-CN")} />
          <StatsCard label="成功次数" value={overall.success.toLocaleString("zh-CN")} tone="success" />
          <StatsCard label="失败次数" value={overall.failed.toLocaleString("zh-CN")} tone="critical" />
          <StatsCard
            label="成功率"
            value={fmtPct(overall.successRate)}
            tone={overall.successRate >= 90 ? "success" : "caution"}
          />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "16px",
            marginTop: "16px",
          }}
        >
          <s-box padding="base" borderRadius="base" borderWidth="base" background="subdued">
            <s-stack direction="block" gap="small">
              <span style={{ fontSize: "0.75rem", color: "var(--p-color-text-success, #007f5f)", fontWeight: 600 }}>
                成功耗时
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>平均</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{fmtMs(overall.successDuration.avgDurationMs)}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>最高</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{fmtMs(overall.successDuration.maxDurationMs)}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>最低</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{fmtMs(overall.successDuration.minDurationMs)}</div>
                </div>
              </div>
            </s-stack>
          </s-box>

          <s-box padding="base" borderRadius="base" borderWidth="base" background="subdued">
            <s-stack direction="block" gap="small">
              <span style={{ fontSize: "0.75rem", color: "var(--p-color-text-critical, #d72c0d)", fontWeight: 600 }}>
                失败耗时
              </span>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>平均</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{fmtMs(overall.failedDuration.avgDurationMs)}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>最高</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{fmtMs(overall.failedDuration.maxDurationMs)}</div>
                </div>
                <div>
                  <div style={{ fontSize: "0.75rem", color: "var(--p-color-text-secondary, #6d7175)" }}>最低</div>
                  <div style={{ fontSize: "1.25rem", fontWeight: 600 }}>{fmtMs(overall.failedDuration.minDurationMs)}</div>
                </div>
              </div>
            </s-stack>
          </s-box>
        </div>
      </s-section>

      {/* ---- 按模型明细 ---- */}
      {byModel.length > 0 && (
        <s-section heading="按模型明细">
          <div style={{ overflowX: "auto" }}>
            <div
              style={{
                border: "1px solid var(--p-color-border-secondary, #c9cccf)",
                borderRadius: "0.75rem",
                overflow: "hidden",
                minWidth: "900px",
              }}
            >
              {/* 表头 */}
              <div className="ai-stats-header"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr",
                  gap: "8px",
                  padding: "12px 16px",
                  background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                  borderBottom: "1px solid var(--p-color-border-secondary, #c9cccf)",
                  fontWeight: 600,
                  fontSize: "0.875rem",
                  color: "var(--p-color-text-secondary, #6d7175)",
                }}
              >
                <span>模型</span>
                <span>总数</span>
                <span>成功</span>
                <span>失败</span>
                <span>成功率</span>
                <span>成功平均</span>
                <span>成功最高</span>
                <span>成功最低</span>
                <span>失败平均</span>
                <span>失败最高</span>
                <span>失败最低</span>
              </div>

              {/* 数据行 */}
              {byModel.map((m, idx) => (
                <div key={m.modelName}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1.5fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr",
                    gap: "8px",
                    padding: "12px 16px",
                    borderBottom: idx < byModel.length - 1
                      ? "1px solid var(--p-color-border-secondary, #c9cccf)"
                      : "none",
                    fontSize: "0.875rem",
                  }}
                >
                  <span style={{ fontWeight: 500 }}>{displayModelName(m.modelName)}</span>
                  <span>{m.total.toLocaleString("zh-CN")}</span>
                  <span style={{ color: "var(--p-color-text-success, #007f5f)" }}>
                    {m.success.toLocaleString("zh-CN")}
                  </span>
                  <span style={{ color: "var(--p-color-text-critical, #d72c0d)" }}>
                    {m.failed.toLocaleString("zh-CN")}
                  </span>
                  <span
                    style={{
                      color: m.successRate >= 90
                        ? "var(--p-color-text-success, #007f5f)"
                        : "var(--p-color-text-caution, #9c6f00)",
                    }}
                  >
                    {fmtPct(m.successRate)}
                  </span>
                  <span>{fmtMs(m.successDuration.avgDurationMs)}</span>
                  <span>{fmtMs(m.successDuration.maxDurationMs)}</span>
                  <span>{m.successDuration.minDurationMs > 0 ? fmtMs(m.successDuration.minDurationMs) : "-"}</span>
                  <span style={m.failed > 0 ? {} : { color: "var(--p-color-text-disabled, #8c9196)" }}>
                    {m.failed > 0 ? fmtMs(m.failedDuration.avgDurationMs) : "-"}
                  </span>
                  <span style={m.failed > 0 ? {} : { color: "var(--p-color-text-disabled, #8c9196)" }}>
                    {m.failed > 0 ? fmtMs(m.failedDuration.maxDurationMs) : "-"}
                  </span>
                  <span style={m.failed > 0 ? {} : { color: "var(--p-color-text-disabled, #8c9196)" }}>
                    {m.failed > 0 && m.failedDuration.minDurationMs > 0 ? fmtMs(m.failedDuration.minDurationMs) : "-"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      )}
    </s-page>
  );
}
