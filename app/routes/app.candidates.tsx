/**
 * File: app/routes/app.candidates.tsx
 * Purpose: 候选列表页面。
 *          展示 scope 内候选图片，支持 group/status 过滤、usage 展开和游标分页。
 *          支持 装饰性标记 / 取消标记 交互，含确认弹窗、loading 态和错误 Toast。
 *          支持候选选择 → 预检确认 → 生成进度 → 完成汇总的完整交互流程。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import styles from "../components/candidates/CandidateListPage.module.css";
import genStyles from "../components/generation/GenerationFlow.module.css";
import { useGenerationFlow } from "../hooks/useGenerationFlow";
import { useInfiniteScroll } from "../hooks/useInfiniteScroll";
import { GenerationFlow } from "../components/generation/GenerationFlow";

type GroupType = "PRODUCT_MEDIA" | "FILES" | "COLLECTION" | "ARTICLE";
type CandidateStatus =
  | "MISSING"
  | "PENDING"
  | "HAS_ALT"
  | "DECORATIVE_SKIPPED"
  | "GENERATION_FAILED_RETRYABLE"
  | "GENERATED"
  | "WRITEBACK_FAILED_RETRYABLE"
  | "WRITTEN"
  | "RESOLVED"
  | "NOT_FOUND"
  | "SKIPPED_ALREADY_FILLED";
type StatusFilter = "" | "PENDING" | "GENERATED" | "HAS_ALT" | "DECORATIVE_SKIPPED";
type ContextMode = "SHARED" | "SINGLE" | string;

interface DashboardGroup {
  groupType: GroupType;
  total: number;
  hasAlt: number;
  missing: number;
  decorative: number;
  pending: number;
  generated: number;
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
  { value: "PENDING", label: "Pending" },
  { value: "GENERATED", label: "Generated" },
  { value: "HAS_ALT", label: "Has Alt" },
  { value: "DECORATIVE_SKIPPED", label: "Decorative" },
];

const STATUS_LABELS: Record<CandidateStatus, string> = {
  MISSING: "Missing",
  PENDING: "Pending",
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

/** 可选中的候选状态（用于生成 Alt Text） */
const SELECTABLE_STATUSES: ReadonlySet<CandidateStatus> = new Set([
  "PENDING",
  "MISSING",
  "GENERATION_FAILED_RETRYABLE",
]);

function normalizeStatusFilter(value: string | null): StatusFilter {
  if (value === "ALL") return "";

  if (
    value === "PENDING" ||
    value === "GENERATED" ||
    value === "HAS_ALT" ||
    value === "DECORATIVE_SKIPPED"
  ) {
    return value;
  }

  if (value === "DECORATIVE") {
    return "DECORATIVE_SKIPPED";
  }

  return "PENDING";
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
  if (status === "MISSING" || status === "PENDING") return styles.badgeCritical;
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
  const [markingIds, setMarkingIds] = useState<Set<string>>(new Set());
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; visible: boolean }>({
    message: "",
    visible: false,
  });

  /* ---- 生成流程状态机 ---- */
  const flow = useGenerationFlow();

  /* ---- 候选选择状态 ---- */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // 当筛选条件变化时清空选择
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // 可选中的候选 ID 列表（当前已加载的 items 中）
  const selectableItems = useMemo(
    () => items.filter((item) => SELECTABLE_STATUSES.has(item.status)),
    [items],
  );

  // 是否正在生成中（禁用选择交互）
  const isGenerating = flow.phase === "STARTING" || flow.phase === "GENERATING";

  const toggleSelect = useCallback(
    (id: string) => {
      if (isGenerating) return;
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [isGenerating],
  );

  const selectAll = useCallback(() => {
    if (isGenerating) return;
    setSelectedIds(new Set(selectableItems.map((item) => item.altCandidateId)));
  }, [isGenerating, selectableItems]);

  const deselectAll = useCallback(() => {
    if (isGenerating) return;
    setSelectedIds(new Set());
  }, [isGenerating]);

  const selectedCount = selectedIds.size;

  const selectedGroupValue = selectedGroup || "";

  const updateFilter = useCallback(
    (next: { group?: GroupType | ""; status?: StatusFilter }) => {
      const params = new URLSearchParams(searchParams);
      const group = next.group ?? selectedGroup;
      const status = next.status ?? selectedStatus;

      if (group) params.set("group", group);
      else params.delete("group");

      if (status) params.set("status", status);
      else params.set("status", "ALL");

      setSearchParams(params);
      setExpandedId(null);
      setUsageByCandidateId({});
      clearSelection();
    },
    [searchParams, selectedGroup, selectedStatus, setSearchParams, clearSelection],
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

  /** 按当前筛选的 group 汇总各状态计数 */
  const filterCounts = useMemo(() => {
    const activeGroups = selectedGroup
      ? groups.filter((g) => g.groupType === selectedGroup)
      : groups;
    const sum = (...keys: Array<"total" | "hasAlt" | "missing" | "decorative" | "pending" | "generated">) =>
      keys.reduce((s, key) => s + activeGroups.reduce((sg, g) => sg + g[key], 0), 0);
    return {
      all: sum("total"),
      pending: sum("pending"),
      generated: sum("generated"),
      hasAlt: sum("hasAlt"),
      decorative: sum("decorative"),
    };
  }, [groups, selectedGroup]);

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
        const response = await fetch(
          `/api/candidates/${encodeURIComponent(item.altCandidateId)}/usages`,
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
    [expandedId, usageByCandidateId],
  );

  /* ---- Toast helper ---- */
  const showToast = useCallback((message: string) => {
    setToast({ message, visible: true });
    window.setTimeout(() => setToast({ message: "", visible: false }), 4000);
  }, []);

  // 生成流程错误 → Toast 显示（IDLE 阶段才有反馈）
  useEffect(() => {
    if (flow.phase === "IDLE" && flow.error) {
      showToast(flow.error);
    }
  }, [flow.phase, flow.error, showToast]);

  /* ---- 装饰性标记 / 取消标记 ---- */
  const handleDecorativeConfirm = useCallback(
    async (item: CandidateItem, action: "mark" | "unmark") => {
      setConfirmId(null);
      setMarkingIds((prev) => {
        const next = new Set(prev);
        next.add(item.altCandidateId);
        return next;
      });

      try {
        const endpoint =
          action === "mark" ? "/api/decorative/mark" : "/api/decorative/unmark";
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ altCandidateId: item.altCandidateId }),
        });

        if (!response.ok) {
          const body = (await response.json()) as { error?: string };
          throw new Error(body.error ?? `操作失败 (${response.status})`);
        }

        const data = (await response.json()) as {
          candidate: { status: CandidateStatus };
        };
        // 实时更新列表项状态（无需整页刷新）
        setItems((current) =>
          current.map((i) =>
            i.altCandidateId === item.altCandidateId
              ? { ...i, status: data.candidate.status as CandidateStatus }
              : i,
          ),
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : "操作失败，请重试");
      } finally {
        setMarkingIds((prev) => {
          const next = new Set(prev);
          next.delete(item.altCandidateId);
          return next;
        });
      }
    },
    [showToast],
  );

  /* ---- 无限滚动（瀑布流） ---- */
  const sentinelRef = useInfiniteScroll({
    hasMore: nextCursor !== null,
    loading: loadingMore,
    onLoadMore: handleLoadMore,
  });

  /* ---- 生成流程触发 ---- */
  const handleGenerateClick = useCallback(() => {
    if (selectedCount === 0) return;
    const candidateIds = Array.from(selectedIds);
    void flow.startPreflight(candidateIds);
  }, [selectedCount, selectedIds, flow]);

  /* ---- 生成完成后刷新列表 ---- */
  const handleCloseSummary = useCallback(() => {
    flow.closeSummary();
    clearSelection();
    // 重新加载候选列表以反映最新状态
    const controller = new AbortController();

    async function reload() {
      try {
        const query = buildCandidateQuery(selectedGroup, selectedStatus);
        const response = await fetch(`/api/candidates?${query}`, { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json() as CandidateListResponse;
        setItems(data.items);
        setNextCursor(data.nextCursor);
      } catch {
        // 刷新失败不影响用户体验
      }
    }

    void reload();
  }, [flow, clearSelection, selectedGroup, selectedStatus]);

  // 判断是否所有可选项都已选中
  const allSelectableSelected = selectableItems.length > 0 &&
    selectableItems.every((item) => selectedIds.has(item.altCandidateId));

  return (
    <>
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
                {STATUS_OPTIONS.map((option) => {
                  const countKey = option.value === "" ? "all"
                    : option.value === "DECORATIVE_SKIPPED" ? "decorative"
                    : option.value === "HAS_ALT" ? "hasAlt"
                    : option.value.toLowerCase() as "all" | "pending" | "generated" | "hasAlt" | "decorative";
                  const count = filterCounts[countKey];
                  return (
                    <button
                      key={option.value || "ALL"}
                      type="button"
                      className={`${styles.tabButton} ${
                        selectedStatus === option.value ? styles.tabButtonActive : ""
                      }`}
                      onClick={() => updateFilter({ status: option.value })}
                    >
                      {option.label}
                      {count > 0 && (
                        <span className={styles.tabCount}> ({count.toLocaleString("zh-CN")})</span>
                      )}
                    </button>
                  );
                })}
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
            {/* ---- 批量选择工具栏 ---- */}
            {selectableItems.length > 0 && (
              <div className={genStyles.selectionToolbar}>
                <div className={genStyles.toolbarLeft}>
                  <button
                    type="button"
                    className={genStyles.toolbarBtn}
                    onClick={allSelectableSelected ? deselectAll : selectAll}
                    disabled={isGenerating}
                  >
                    {allSelectableSelected ? "取消全选" : "全选"}
                  </button>
                  <span className={genStyles.toolbarText}>
                    已选 {selectedCount} 张
                  </span>
                </div>
                <div className={genStyles.toolbarRight}>
                  <div
                    onClick={selectedCount > 0 && !isGenerating ? handleGenerateClick : undefined}
                    style={{ display: "inline-block", cursor: selectedCount > 0 && !isGenerating ? "pointer" : "default" }}
                  >
                    <s-button
                      variant="primary"
                      accessibilityLabel="Generate Alt Text"
                      {...(selectedCount === 0 || isGenerating ? { disabled: true } : {})}
                    >
                      Generate Alt Text{selectedCount > 0 ? ` (${selectedCount})` : ""}
                    </s-button>
                  </div>
                </div>
              </div>
            )}

            <div className={styles.list}>
              {items.map((item) => {
                const usageState = usageByCandidateId[item.altCandidateId];
                const isExpanded = expandedId === item.id;
                const isSelectable = SELECTABLE_STATUSES.has(item.status);
                const isSelected = selectedIds.has(item.altCandidateId);

                return (
                  <s-box
                    key={item.id}
                    padding="base"
                    borderRadius="base"
                    borderWidth="base"
                  >
                    <div className={styles.row}>
                      {/* ---- 复选框 ---- */}
                      <div className={genStyles.checkboxCell}>
                        <input
                          type="checkbox"
                          className={genStyles.checkboxInput}
                          checked={isSelected}
                          disabled={!isSelectable || isGenerating}
                          onChange={() => toggleSelect(item.altCandidateId)}
                          aria-label={`选择 ${item.primaryUsage.title ?? "未命名资源"}`}
                        />
                      </div>

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

                        {item.draftAlt && (
                          <s-text tone="neutral">
                            {item.draftAlt}
                          </s-text>
                        )}

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
                        {/* 装饰性标记 / 取消标记 */}
                        {(item.status === "MISSING" ||
                          item.status === "PENDING" ||
                          item.status === "DECORATIVE_SKIPPED") && (
                          <>
                            {confirmId === item.altCandidateId ? (
                              <div className={styles.confirmRow}>
                                <span style={{ fontSize: "0.8125rem" }}>
                                  确认?
                                </span>
                                <button
                                  type="button"
                                  className={styles.confirmYes}
                                  onClick={() =>
                                    void handleDecorativeConfirm(
                                      item,
                                      item.status === "PENDING" || item.status === "MISSING"
                                        ? "mark"
                                        : "unmark",
                                    )
                                  }
                                >
                                  确认
                                </button>
                                <button
                                  type="button"
                                  className={styles.confirmNo}
                                  onClick={() => setConfirmId(null)}
                                >
                                  取消
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className={`${styles.decorativeBtn} ${
                                  item.status === "DECORATIVE_SKIPPED"
                                    ? styles.decorativeBtnActive
                                    : ""
                                }`}
                                disabled={markingIds.has(item.altCandidateId)}
                                onClick={() =>
                                  setConfirmId(item.altCandidateId)
                                }
                              >
                                {markingIds.has(item.altCandidateId)
                                  ? "处理中…"
                                  : item.status === "PENDING" || item.status === "MISSING"
                                    ? "标记为装饰性"
                                    : "取消装饰性标记"}
                              </button>
                            )}
                          </>
                        )}
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
                                    {usage.usageId}
                                  </s-link>
                                </s-stack>
                                {usage.usageType === "PRODUCT" && (
                                  <s-text tone="neutral">
                                    {formatUsagePosition(usage.positionIndex)}
                                  </s-text>
                                )}
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

            {/* 瀑布流哨兵 —— 进入视口即自动加载更多 */}
            {nextCursor && (
              <div ref={sentinelRef} className={styles.loadMore}>
                {loadingMore && <s-text tone="neutral">正在加载更多…</s-text>}
              </div>
            )}
          </s-stack>
        )}
      </s-section>
    </s-page>

    {/* 生成流程 Modal / Progress / Summary */}
    <GenerationFlow
      phase={flow.phase}
      preflightResult={flow.preflightResult}
      totalCount={flow.totalCount}
      progress={flow.progress}
      summary={flow.summary}
      error={flow.error}
      connected={flow.connected}
      percent={flow.percent}
      onConfirmAndStart={flow.confirmAndStart}
      onCancel={flow.cancel}
      onCloseSummary={handleCloseSummary}
    />

    {/* 错误 Toast */}
    {toast.visible && (
      <div className={styles.toast}>
        <s-text tone="critical">{toast.message}</s-text>
      </div>
    )}
  </>
);
}
