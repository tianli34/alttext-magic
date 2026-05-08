/**
 * File: app/routes/app.candidates.tsx
 * Purpose: 候选列表页面。
 *          展示 scope 内候选图片，支持 group/status 过滤、usage 展开和游标分页。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import styles from "../components/candidates/CandidateListPage.module.css";

type GroupType = "PRODUCT_MEDIA" | "FILES" | "COLLECTION" | "ARTICLE";
type CandidateStatus =
  | "MISSING"
  | "HAS_ALT"
  | "DECORATIVE_SKIPPED"
  | "GENERATION_FAILED_RETRYABLE"
  | "GENERATED"
  | "WRITEBACK_FAILED_RETRYABLE"
  | "WRITTEN"
  | "RESOLVED"
  | "NOT_FOUND"
  | "SKIPPED_ALREADY_FILLED";
type StatusFilter = "" | "MISSING" | "HAS_ALT" | "DECORATIVE_SKIPPED";
type ContextMode = "SHARED" | "SINGLE" | string;

interface DashboardGroup {
  groupType: GroupType;
  total: number;
  hasAlt: number;
  missing: number;
  decorative: number;
}

interface DashboardResponse {
  groups: DashboardGroup[];
  lastPublishedAt: string | null;
  isScanning: boolean;
}

interface CandidatePrimaryUsage {
  type: string;
  id: string;
  title: string | null;
  handle: string | null;
  positionIndex: number | null;
}

interface CandidateItem {
  id: string;
  altCandidateId: string;
  thumbnailUrl: string | null;
  groupType: GroupType;
  primaryUsage: CandidatePrimaryUsage;
  additionalUsageCount: number;
  usageCountPresent: number;
  contextMode: ContextMode | null;
  status: CandidateStatus;
  currentAlt: string | null;
  draftAlt: string | null;
  impactScopeSummary: unknown;
}

interface CandidateListResponse {
  items: CandidateItem[];
  nextCursor: string | null;
}

interface UsageDetail {
  usageType: string;
  usageId: string;
  title: string | null;
  handle: string | null;
  positionIndex: number | null;
  currentAlt: string | null;
  shopifyAdminUrl: string;
}

interface UsageListResponse {
  usages: UsageDetail[];
}

interface UsageState {
  loading: boolean;
  error: string | null;
  usages: UsageDetail[];
}

const GROUP_LABELS: Record<GroupType, string> = {
  PRODUCT_MEDIA: "商品图片",
  FILES: "文件图片",
  COLLECTION: "合集图片",
  ARTICLE: "文章图片",
};

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "", label: "All" },
  { value: "MISSING", label: "Missing" },
  { value: "HAS_ALT", label: "Has Alt" },
  { value: "DECORATIVE_SKIPPED", label: "Decorative" },
];

const STATUS_LABELS: Record<CandidateStatus, string> = {
  MISSING: "Missing",
  HAS_ALT: "Has Alt",
  DECORATIVE_SKIPPED: "Decorative",
  GENERATION_FAILED_RETRYABLE: "Generation failed",
  GENERATED: "Generated",
  WRITEBACK_FAILED_RETRYABLE: "Writeback failed",
  WRITTEN: "Written",
  RESOLVED: "Resolved",
  NOT_FOUND: "Not found",
  SKIPPED_ALREADY_FILLED: "Already filled",
};

function normalizeStatusFilter(value: string | null): StatusFilter {
  if (
    value === "MISSING" ||
    value === "HAS_ALT" ||
    value === "DECORATIVE_SKIPPED"
  ) {
    return value;
  }

  if (value === "DECORATIVE") {
    return "DECORATIVE_SKIPPED";
  }

  return "";
}

function isGroupType(value: string | null): value is GroupType {
  return (
    value === "PRODUCT_MEDIA" ||
    value === "FILES" ||
    value === "COLLECTION" ||
    value === "ARTICLE"
  );
}

function getStatusToneClass(status: CandidateStatus): string {
  if (status === "MISSING") return styles.badgeCritical;
  if (status === "HAS_ALT") return styles.badgeSuccess;
  if (status === "DECORATIVE_SKIPPED") return styles.badgeCaution;
  return "";
}

function formatPosition(positionIndex: number | null, usageCount: number): string {
  if (positionIndex !== null) {
    return `Image ${positionIndex} of ${usageCount}`;
  }

  return usageCount > 0 ? `${usageCount} usages` : "位置未知";
}

function formatUsagePosition(positionIndex: number | null): string {
  return positionIndex === null ? "位置未知" : `Image ${positionIndex}`;
}

function buildCandidateQuery(
  group: GroupType | "",
  status: StatusFilter,
  cursor?: string,
): string {
  const params = new URLSearchParams();
  params.set("limit", "20");
  if (group) params.set("group", group);
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function mergeUniqueItems(
  currentItems: readonly CandidateItem[],
  nextItems: readonly CandidateItem[],
): CandidateItem[] {
  const seen = new Set(currentItems.map((item) => item.id));
  const merged = [...currentItems];

  for (const item of nextItems) {
    if (!seen.has(item.id)) {
      merged.push(item);
      seen.add(item.id);
    }
  }

  return merged;
}

export default function AppCandidatesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedGroup = isGroupType(searchParams.get("group"))
    ? searchParams.get("group") as GroupType
    : "";
  const selectedStatus = normalizeStatusFilter(searchParams.get("status"));

  const [groups, setGroups] = useState<DashboardGroup[]>([]);
  const [items, setItems] = useState<CandidateItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [usageByCandidateId, setUsageByCandidateId] = useState<Record<string, UsageState>>({});

  const selectedGroupValue = selectedGroup || "";

  const updateFilter = useCallback(
    (next: { group?: GroupType | ""; status?: StatusFilter }) => {
      const params = new URLSearchParams(searchParams);
      const group = next.group ?? selectedGroup;
      const status = next.status ?? selectedStatus;

      if (group) params.set("group", group);
      else params.delete("group");

      if (status) params.set("status", status);
      else params.delete("status");

      setSearchParams(params);
      setExpandedId(null);
      setUsageByCandidateId({});
    },
    [searchParams, selectedGroup, selectedStatus, setSearchParams],
  );

  const fetchCandidates = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      const query = buildCandidateQuery(selectedGroup, selectedStatus, cursor);
      const response = await fetch(`/api/candidates?${query}`, { signal });

      if (!response.ok) {
        throw new Error(`候选列表加载失败 (${response.status})`);
      }

      return await response.json() as CandidateListResponse;
    },
    [selectedGroup, selectedStatus],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadInitialData() {
      setLoading(true);
      setError(null);

      try {
        const [dashboardResponse, candidateResponse] = await Promise.all([
          fetch("/api/dashboard", { signal: controller.signal }),
          fetchCandidates(controller.signal),
        ]);

        if (!dashboardResponse.ok) {
          throw new Error(`分组筛选加载失败 (${dashboardResponse.status})`);
        }

        const dashboard = await dashboardResponse.json() as DashboardResponse;
        const candidates = candidateResponse;

        setGroups(dashboard.groups);
        setItems(candidates.items);
        setNextCursor(candidates.nextCursor);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "加载失败，请刷新页面重试");
      } finally {
        setLoading(false);
      }
    }

    loadInitialData();

    return () => {
      controller.abort();
    };
  }, [fetchCandidates]);

  const groupOptions = useMemo(() => groups, [groups]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;

    const controller = new AbortController();
    setLoadingMore(true);
    setError(null);

    try {
      const response = await fetchCandidates(controller.signal, nextCursor);
      setItems((current) => mergeUniqueItems(current, response.items));
      setNextCursor(response.nextCursor);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }, [fetchCandidates, loadingMore, nextCursor]);

  const toggleUsages = useCallback(
    async (item: CandidateItem) => {
      if (expandedId === item.id) {
        setExpandedId(null);
        return;
      }

      setExpandedId(item.id);
      if (usageByCandidateId[item.altCandidateId]) {
        return;
      }

      setUsageByCandidateId((current) => ({
        ...current,
        [item.altCandidateId]: { loading: true, error: null, usages: [] },
      }));

      try {
        const params = new URLSearchParams();
        if (selectedGroup) params.set("group", selectedGroup);
        const query = params.toString();
        const response = await fetch(
          `/api/candidates/${encodeURIComponent(item.altCandidateId)}/usages${query ? `?${query}` : ""}`,
        );

        if (!response.ok) {
          throw new Error(`影响范围加载失败 (${response.status})`);
        }

        const data = await response.json() as UsageListResponse;
        setUsageByCandidateId((current) => ({
          ...current,
          [item.altCandidateId]: { loading: false, error: null, usages: data.usages },
        }));
      } catch (err) {
        setUsageByCandidateId((current) => ({
          ...current,
          [item.altCandidateId]: {
            loading: false,
            error: err instanceof Error ? err.message : "影响范围加载失败",
            usages: [],
          },
        }));
      }
    },
    [expandedId, selectedGroup, usageByCandidateId],
  );

  return (
    <s-page heading="候选列表">
      <s-section heading="筛选">
        <s-stack direction="block" gap="base">
          <div className={styles.toolbar}>
            <label className={styles.field}>
              <s-text tone="neutral">Group</s-text>
              <select
                className={styles.select}
                value={selectedGroupValue}
                onChange={(event) =>
                  updateFilter({ group: event.currentTarget.value as GroupType | "" })
                }
              >
                <option value="">全部 scope 内分组</option>
                {groupOptions.map((group) => (
                  <option key={group.groupType} value={group.groupType}>
                    {GROUP_LABELS[group.groupType]}
                  </option>
                ))}
              </select>
            </label>

            <div className={styles.field}>
              <s-text tone="neutral">Status</s-text>
              <div className={styles.tabs} role="tablist" aria-label="候选状态筛选">
                {STATUS_OPTIONS.map((option) => (
                  <button
                    key={option.value || "ALL"}
                    type="button"
                    className={`${styles.tabButton} ${
                      selectedStatus === option.value ? styles.tabButtonActive : ""
                    }`}
                    onClick={() => updateFilter({ status: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {error && (
            <s-box padding="base" borderRadius="base" background="strong">
              <s-text tone="critical">{error}</s-text>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section heading="图片">
        {loading ? (
          <s-box padding="base" borderRadius="base" background="subdued" borderWidth="base">
            <s-text tone="neutral">正在加载候选图片…</s-text>
          </s-box>
        ) : items.length === 0 ? (
          <s-box padding="base" borderRadius="base" background="subdued" borderWidth="base">
            <s-stack direction="block" gap="small">
              <s-heading>暂无候选图片</s-heading>
              <s-text tone="neutral">当前筛选条件下没有需要处理的图片。</s-text>
            </s-stack>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            <div className={styles.list}>
              {items.map((item) => {
                const usageState = usageByCandidateId[item.altCandidateId];
                const isExpanded = expandedId === item.id;

                return (
                  <s-box
                    key={item.id}
                    padding="base"
                    borderRadius="base"
                    borderWidth="base"
                  >
                    <div className={styles.row}>
                      {item.thumbnailUrl ? (
                        <img
                          className={styles.thumbnail}
                          src={item.thumbnailUrl}
                          alt=""
                          loading="lazy"
                        />
                      ) : (
                        <div className={styles.thumbnailFallback}>No image</div>
                      )}

                      <s-stack direction="block" gap="small">
                        <div className={styles.meta}>
                          <span className={styles.badge}>{GROUP_LABELS[item.groupType]}</span>
                          <span className={`${styles.badge} ${getStatusToneClass(item.status)}`}>
                            {STATUS_LABELS[item.status] ?? item.status}
                          </span>
                          {item.contextMode && (
                            <span className={styles.badge}>{item.contextMode}</span>
                          )}
                        </div>

                        <s-heading>
                          {item.primaryUsage.title ?? item.primaryUsage.handle ?? "未命名资源"}
                        </s-heading>

                        <s-stack direction="inline" gap="base">
                          <s-text tone="neutral">
                            {formatPosition(
                              item.primaryUsage.positionIndex,
                              item.usageCountPresent,
                            )}
                          </s-text>
                          <s-text tone="neutral">
                            总使用数 {item.usageCountPresent.toLocaleString("zh-CN")}
                          </s-text>
                        </s-stack>

                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => void toggleUsages(item)}
                        >
                          {item.additionalUsageCount > 0
                            ? `+${item.additionalUsageCount.toLocaleString("zh-CN")} more usages`
                            : "查看影响范围"}
                        </button>
                      </s-stack>

                      <div className={styles.rowAction}>
                        <button
                          type="button"
                          className={styles.linkButton}
                          onClick={() => void toggleUsages(item)}
                        >
                          {isExpanded ? "收起" : "展开"}
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className={styles.usagePanel}>
                        {usageState?.loading ? (
                          <s-text tone="neutral">正在加载影响范围…</s-text>
                        ) : usageState?.error ? (
                          <s-text tone="critical">{usageState.error}</s-text>
                        ) : usageState && usageState.usages.length > 0 ? (
                          <div className={styles.usageList}>
                            {usageState.usages.map((usage) => (
                              <div
                                key={`${usage.usageType}-${usage.usageId}-${usage.positionIndex ?? "none"}`}
                                className={styles.usageItem}
                              >
                                <s-stack direction="inline" gap="small">
                                  <span className={styles.badge}>{usage.usageType}</span>
                                  <s-link href={usage.shopifyAdminUrl} target="_blank">
                                    {usage.title ?? usage.handle ?? usage.usageId}
                                  </s-link>
                                </s-stack>
                                <s-text tone="neutral">
                                  {formatUsagePosition(usage.positionIndex)}
                                </s-text>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <s-text tone="neutral">暂无可展示的影响范围。</s-text>
                        )}
                      </div>
                    )}
                  </s-box>
                );
              })}
            </div>

            {nextCursor && (
              <div className={styles.loadMore}>
                <div onClick={() => void handleLoadMore()}>
                  <s-button
                    variant="secondary"
                    accessibilityLabel="加载更多候选图片"
                    {...(loadingMore ? { disabled: true } : {})}
                  >
                    {loadingMore ? "正在加载…" : "加载更多"}
                  </s-button>
                </div>
              </div>
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>
  );
}
