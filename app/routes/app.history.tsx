/**
 * File: app/routes/app.history.tsx
 * Purpose: 写回审计历史页面。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import styles from "../components/history/HistoryPage.module.css";

type AltPlane = "FILE_ALT" | "COLLECTION_IMAGE_ALT" | "ARTICLE_IMAGE_ALT";
type AltPlaneFilter = "" | AltPlane;

interface HistoryItem {
  id: string;
  altPlane: AltPlane;
  oldAltText: string | null;
  newAltText: string;
  modelUsed: string;
  writtenAt: string;
  altTarget: {
    shopifyGid: string;
    thumbnailUrl: string | null;
    primaryUsage: {
      type: string;
      id: string;
      title: string | null;
      handle: string | null;
      positionIndex: number | null;
    } | null;
  };
}

interface HistoryResponse {
  items: HistoryItem[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

const ALT_PLANE_OPTIONS: Array<{ value: AltPlaneFilter; label: string }> = [
  { value: "", label: "全部类型" },
  { value: "FILE_ALT", label: "文件" },
  { value: "COLLECTION_IMAGE_ALT", label: "集合封面" },
  { value: "ARTICLE_IMAGE_ALT", label: "文章封面" },
];

const ALT_PLANE_LABELS: Record<AltPlane, string> = {
  FILE_ALT: "文件",
  COLLECTION_IMAGE_ALT: "集合封面",
  ARTICLE_IMAGE_ALT: "文章封面",
};

function normalizeAltPlane(value: string | null): AltPlaneFilter {
  if (
    value === "FILE_ALT" ||
    value === "COLLECTION_IMAGE_ALT" ||
    value === "ARTICLE_IMAGE_ALT"
  ) {
    return value;
  }

  return "";
}

function normalizePage(value: string | null): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function formatUsage(item: HistoryItem): string {
  const usage = item.altTarget.primaryUsage;
  if (!usage) return "无主使用位置";
  const title = usage.title ?? usage.handle ?? usage.id;
  const position = usage.positionIndex === null ? "" : ` · 位置 ${usage.positionIndex}`;
  return `${title}${position}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function AppHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAltPlane = normalizeAltPlane(searchParams.get("altPlane"));
  const selectedPage = normalizePage(searchParams.get("page"));
  const pageSize = 20;

  const [items, setItems] = useState<HistoryItem[]>([]);
  const [meta, setMeta] = useState<HistoryResponse["meta"]>({
    total: 0,
    page: 1,
    pageSize,
    totalPages: 1,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setFilter = useCallback(
    (next: { altPlane?: AltPlaneFilter; page?: number }) => {
      const params = new URLSearchParams(searchParams);
      const altPlane = next.altPlane ?? selectedAltPlane;
      const page = next.page ?? 1;

      if (altPlane) params.set("altPlane", altPlane);
      else params.delete("altPlane");

      if (page > 1) params.set("page", String(page));
      else params.delete("page");

      setSearchParams(params);
    },
    [searchParams, selectedAltPlane, setSearchParams],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        params.set("page", String(selectedPage));
        params.set("pageSize", String(pageSize));
        if (selectedAltPlane) params.set("altPlane", selectedAltPlane);

        const response = await fetch(`/api/history?${params.toString()}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`历史记录加载失败 (${response.status})`);
        }

        const data = (await response.json()) as HistoryResponse;
        setItems(data.items);
        setMeta(data.meta);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "历史记录加载失败");
      } finally {
        setLoading(false);
      }
    }

    void load();

    return () => controller.abort();
  }, [selectedAltPlane, selectedPage]);

  const pageInfo = useMemo(
    () => `${meta.page.toLocaleString("zh-CN")} / ${meta.totalPages.toLocaleString("zh-CN")}`,
    [meta.page, meta.totalPages],
  );

  return (
    <s-page heading="写回历史">
      <s-section heading="筛选">
        <div className={styles.toolbar}>
          <label className={styles.field}>
            <s-text tone="neutral">图片类型</s-text>
            <select
              className={styles.select}
              value={selectedAltPlane}
              onChange={(event) =>
                setFilter({ altPlane: event.currentTarget.value as AltPlaneFilter })
              }
            >
              {ALT_PLANE_OPTIONS.map((option) => (
                <option key={option.value || "ALL"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <s-text tone="neutral">
            默认展示最近 90 天写回记录，共 {meta.total.toLocaleString("zh-CN")} 条
          </s-text>
        </div>
      </s-section>

      <s-section heading="记录">
        {error && (
          <div className={styles.errorBox}>
            <s-text tone="critical">{error}</s-text>
          </div>
        )}

        {loading ? (
          <div className={styles.emptyBox}>
            <s-text tone="neutral">正在加载写回历史...</s-text>
          </div>
        ) : items.length === 0 ? (
          <div className={styles.emptyBox}>
            <s-stack direction="block" gap="small">
              <s-heading>暂无写回记录</s-heading>
              <s-text tone="neutral">完成首次写回后将在此展示历史。</s-text>
            </s-stack>
          </div>
        ) : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>缩略图</th>
                    <th>图片位置</th>
                    <th>图片类型</th>
                    <th>旧 Alt Text</th>
                    <th>新 Alt Text</th>
                    <th>AI 模型</th>
                    <th>写回时间</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.altTarget.thumbnailUrl ? (
                          <img
                            className={styles.thumbnail}
                            src={item.altTarget.thumbnailUrl}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <div className={styles.thumbnailFallback}>No image</div>
                        )}
                      </td>
                      <td className={styles.textCell}>{formatUsage(item)}</td>
                      <td>
                        <span className={styles.badge}>
                          {ALT_PLANE_LABELS[item.altPlane]}
                        </span>
                      </td>
                      <td className={styles.textCell}>{item.oldAltText || "(无)"}</td>
                      <td className={styles.textCell}>{item.newAltText}</td>
                      <td>{item.modelUsed}</td>
                      <td>{formatDate(item.writtenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.pagination}>
              <button
                type="button"
                className={styles.button}
                disabled={meta.page <= 1}
                onClick={() => setFilter({ page: meta.page - 1 })}
              >
                上一页
              </button>
              <s-text tone="neutral">{pageInfo}</s-text>
              <button
                type="button"
                className={styles.button}
                disabled={meta.page >= meta.totalPages}
                onClick={() => setFilter({ page: meta.page + 1 })}
              >
                下一页
              </button>
            </div>
          </>
        )}
      </s-section>
    </s-page>
  );
}
