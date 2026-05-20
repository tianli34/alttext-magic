/**
 * File: app/routes/app.review.tsx
 * Purpose: 审阅/编辑页面。
 *          展示 Phase 6 已生成草稿，支持筛选、分页、编辑保存、装饰性切换与批量写回入口。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import styles from "../components/review/ReviewListPage.module.css";
import {
  WritebackConfirmModal,
  type WritebackConfirmItem,
} from "../components/review/WritebackConfirmModal";
import { ProgressBar } from "../components/common/ProgressBar";
import {
  useWritebackSSE,
  type WritebackProgressData,
  type WritebackBatchStatus,
} from "../hooks/useWritebackSSE";

type AltPlane = "FILE_ALT" | "COLLECTION_IMAGE_ALT" | "ARTICLE_IMAGE_ALT";
type ReviewStatus = "GENERATED" | "WRITEBACK_FAILED_RETRYABLE";
type StatusFilter = "" | ReviewStatus;
type AltPlaneFilter = "" | AltPlane;

interface PrimaryUsage {
  type: string;
  id: string;
  title: string | null;
  handle: string | null;
  positionIndex: number | null;
}

interface ReviewListItem {
  candidate: {
    id: string;
    status: ReviewStatus;
    altPlane: AltPlane;
    isDecorative: boolean;
    errorMessage: string | null;
    retryCount: number;
  };
  target: {
    shopifyGid: string;
    thumbnailUrl: string | null;
    currentAltText: string | null;
    primaryUsage: PrimaryUsage | null;
    usageCountPresent: number;
  };
  draft: {
    aiGeneratedText: string;
    editedText: string | null;
    modelUsed: string;
    createdAt: string;
  } | null;
  displayText: string;
  isSharedFile: boolean;
}

interface ReviewListMeta {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ReviewListResponse {
  items: ReviewListItem[];
  meta: ReviewListMeta;
}

interface DraftUpdateResponse {
  success: boolean;
  draft: {
    id: string;
    editedText: string | null;
    updatedAt: string;
  };
}

interface ApiErrorResponse {
  error?: string;
  code?: string;
}

interface WritebackTypeStat {
  altPlane: AltPlane;
  total: number;
  success: number;
  fail: number;
  skip: number;
}

interface WritebackBatchDetail extends WritebackProgressData {
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  typeStats: WritebackTypeStat[];
  isTerminal: boolean;
}

const ALT_PLANE_OPTIONS: Array<{ value: AltPlaneFilter; label: string }> = [
  { value: "", label: "全部类型" },
  { value: "FILE_ALT", label: "文件" },
  { value: "COLLECTION_IMAGE_ALT", label: "集合" },
  { value: "ARTICLE_IMAGE_ALT", label: "文章" },
];

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: "", label: "全部状态" },
  { value: "GENERATED", label: "已生成" },
  { value: "WRITEBACK_FAILED_RETRYABLE", label: "写回失败" },
];

const ALT_PLANE_LABELS: Record<AltPlane, string> = {
  FILE_ALT: "FILE_ALT",
  COLLECTION_IMAGE_ALT: "COLLECTION_IMAGE_ALT",
  ARTICLE_IMAGE_ALT: "ARTICLE_IMAGE_ALT",
};

const STATUS_LABELS: Record<ReviewStatus, string> = {
  GENERATED: "GENERATED",
  WRITEBACK_FAILED_RETRYABLE: "写回失败",
};

const BATCH_STATUS_LABELS: Record<WritebackBatchStatus, string> = {
  PENDING: "等待中",
  RUNNING: "写回中",
  SUCCESS: "写回完成",
  PARTIAL_SUCCESS: "部分失败",
  FAILED: "写回失败",
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

function normalizeStatus(value: string | null): StatusFilter {
  if (value === "GENERATED" || value === "WRITEBACK_FAILED_RETRYABLE") {
    return value;
  }

  return "";
}

function normalizePage(value: string | null): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function getPrimaryUsageTitle(item: ReviewListItem): string {
  return (
    item.target.primaryUsage?.title ??
    item.target.primaryUsage?.handle ??
    item.target.primaryUsage?.id ??
    item.target.shopifyGid
  );
}

function getPrimaryUsageMeta(primaryUsage: PrimaryUsage | null): string {
  if (!primaryUsage) return "无主使用位置";

  const parts = [primaryUsage.type];
  if (primaryUsage.positionIndex !== null) {
    parts.push(`位置 ${primaryUsage.positionIndex}`);
  }
  if (primaryUsage.handle) {
    parts.push(primaryUsage.handle);
  }

  return parts.join(" · ");
}

function isTerminalBatch(status: WritebackBatchStatus): boolean {
  return status === "SUCCESS" || status === "PARTIAL_SUCCESS" || status === "FAILED";
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "处理中";
  const seconds = Math.max(Math.round(durationMs / 1000), 0);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function truncateText(value: string | null, maxLength = 140): string {
  if (!value) return "未知错误";
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorResponse;
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

export default function AppReviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedAltPlane = normalizeAltPlane(searchParams.get("altPlane"));
  const selectedStatus = normalizeStatus(searchParams.get("status"));
  const selectedPage = normalizePage(searchParams.get("page"));
  const selectedBatchId = searchParams.get("batchId");
  const pageSize = 20;

  const [items, setItems] = useState<ReviewListItem[]>([]);
  const [meta, setMeta] = useState<ReviewListMeta>({
    total: 0,
    page: 1,
    pageSize,
    totalPages: 1,
  });
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [decorativeIds, setDecorativeIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [writingBack, setWritingBack] = useState(false);
  const [showWritebackModal, setShowWritebackModal] = useState(false);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(
    selectedBatchId,
  );
  const [batchDetail, setBatchDetail] = useState<WritebackBatchDetail | null>(null);
  const [batchLoading, setBatchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "critical" | "success" } | null>(null);

  const showToast = useCallback((message: string, tone: "critical" | "success" = "critical") => {
    setToast({ message, tone });
    window.setTimeout(() => setToast(null), 4000);
  }, []);

  const setFilter = useCallback(
    (next: { altPlane?: AltPlaneFilter; status?: StatusFilter; page?: number }) => {
      const params = new URLSearchParams(searchParams);
      const altPlane = next.altPlane ?? selectedAltPlane;
      const status = next.status ?? selectedStatus;
      const page = next.page ?? 1;

      if (altPlane) params.set("altPlane", altPlane);
      else params.delete("altPlane");

      if (status) params.set("status", status);
      else params.delete("status");

      if (page > 1) params.set("page", String(page));
      else params.delete("page");

      setSelectedIds(new Set());
      setSearchParams(params);
    },
    [searchParams, selectedAltPlane, selectedStatus, setSearchParams],
  );

  const setBatchParam = useCallback(
    (batchId: string | null) => {
      const params = new URLSearchParams(searchParams);
      if (batchId) params.set("batchId", batchId);
      else params.delete("batchId");
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const fetchReviewItems = useCallback(
    async (signal: AbortSignal) => {
      const params = new URLSearchParams();
      params.set("page", String(selectedPage));
      params.set("pageSize", String(pageSize));
      if (selectedAltPlane) params.set("altPlane", selectedAltPlane);
      if (selectedStatus) params.set("status", selectedStatus);

      const response = await fetch(`/api/candidates/review?${params.toString()}`, { signal });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `审阅列表加载失败 (${response.status})`));
      }

      return (await response.json()) as ReviewListResponse;
    },
    [selectedAltPlane, selectedPage, selectedStatus],
  );

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchReviewItems(controller.signal);
        setItems(data.items);
        setMeta(data.meta);
        setDraftValues(
          Object.fromEntries(
            data.items.map((item) => [item.candidate.id, item.displayText]),
          ),
        );
        setDecorativeIds(
          new Set(
            data.items
              .filter((item) => item.candidate.isDecorative)
              .map((item) => item.candidate.id),
          ),
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "加载失败，请刷新页面重试");
      } finally {
        setLoading(false);
      }
    }

    void load();

    return () => controller.abort();
  }, [fetchReviewItems]);

  const loadBatchDetail = useCallback(
    async (batchId: string, signal?: AbortSignal) => {
      setBatchLoading(true);
      try {
        const response = await fetch(
          `/api/writeback/batch/${encodeURIComponent(batchId)}`,
          { signal },
        );

        if (!response.ok) {
          throw new Error(await readErrorMessage(response, `写回批次加载失败 (${response.status})`));
        }

        const detail = (await response.json()) as WritebackBatchDetail;
        setBatchDetail(detail);
        if (!detail.isTerminal) {
          setActiveBatchId(batchId);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        showToast(err instanceof Error ? err.message : "写回批次加载失败");
      } finally {
        setBatchLoading(false);
      }
    },
    [showToast],
  );

  const handleWritebackComplete = useCallback(
    (data: WritebackProgressData) => {
      setBatchDetail((current) =>
        current
          ? { ...current, ...data, isTerminal: true }
          : {
              ...data,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              durationMs: null,
              typeStats: [],
              isTerminal: true,
            },
      );
      void loadBatchDetail(data.batchId);
    },
    [loadBatchDetail],
  );

  const writebackSSE = useWritebackSSE(
    activeBatchId && (!batchDetail || !batchDetail.isTerminal) ? activeBatchId : null,
    handleWritebackComplete,
  );

  const effectiveProgress = writebackSSE.progress ?? batchDetail;
  const writebackPercent = effectiveProgress && effectiveProgress.total > 0
    ? Math.round(
        ((effectiveProgress.success + effectiveProgress.fail + effectiveProgress.skip) /
          effectiveProgress.total) *
          100,
      )
    : 0;

  useEffect(() => {
    if (!selectedBatchId) return;

    const controller = new AbortController();
    setActiveBatchId(selectedBatchId);
    void loadBatchDetail(selectedBatchId, controller.signal);

    return () => controller.abort();
  }, [loadBatchDetail, selectedBatchId]);

  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.candidate.id));

  const toggleSelect = useCallback((candidateId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  }, []);

  const toggleSelectPage = useCallback(() => {
    setSelectedIds((current) => {
      if (items.length > 0 && items.every((item) => current.has(item.candidate.id))) {
        return new Set();
      }

      return new Set(items.map((item) => item.candidate.id));
    });
  }, [items]);

  const updateItem = useCallback((candidateId: string, patch: Partial<ReviewListItem>) => {
    setItems((current) =>
      current.map((item) =>
        item.candidate.id === candidateId
          ? {
              ...item,
              ...patch,
              candidate: {
                ...item.candidate,
                ...patch.candidate,
              },
            }
          : item,
      ),
    );
  }, []);

  const saveDraft = useCallback(
    async (item: ReviewListItem) => {
      const candidateId = item.candidate.id;
      const nextText = draftValues[candidateId] ?? "";
      const previousText = item.displayText;

      if (nextText === previousText) return;

      if (nextText.trim().length === 0) {
        setDraftValues((current) => ({ ...current, [candidateId]: previousText }));
        showToast("编辑内容不能为空");
        return;
      }

      setSavingIds((current) => new Set(current).add(candidateId));
      updateItem(candidateId, { displayText: nextText });

      try {
        const response = await fetch("/api/draft/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ candidateId, editedText: nextText }),
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response, `保存失败 (${response.status})`));
        }

        const data = (await response.json()) as DraftUpdateResponse;
        if (!data.success) {
          throw new Error("保存失败");
        }

        showToast("编辑已保存", "success");
      } catch (err) {
        setDraftValues((current) => ({ ...current, [candidateId]: previousText }));
        updateItem(candidateId, { displayText: previousText });
        showToast(err instanceof Error ? err.message : "保存失败，请重试");
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(candidateId);
          return next;
        });
      }
    },
    [draftValues, showToast, updateItem],
  );

  const toggleDecorative = useCallback(
    async (item: ReviewListItem) => {
      const candidateId = item.candidate.id;
      const wasDecorative = decorativeIds.has(candidateId);
      const endpoint = wasDecorative ? "/api/decorative/unmark" : "/api/decorative/mark";

      setDecorativeIds((current) => {
        const next = new Set(current);
        if (wasDecorative) next.delete(candidateId);
        else next.add(candidateId);
        return next;
      });
      updateItem(candidateId, {
        candidate: { ...item.candidate, isDecorative: !wasDecorative },
      });

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ altCandidateId: candidateId }),
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response, `装饰性标记失败 (${response.status})`));
        }

        showToast(wasDecorative ? "已取消装饰性标记" : "已标记为装饰性", "success");
      } catch (err) {
        setDecorativeIds((current) => {
          const next = new Set(current);
          if (wasDecorative) next.add(candidateId);
          else next.delete(candidateId);
          return next;
        });
        updateItem(candidateId, {
          candidate: { ...item.candidate, isDecorative: wasDecorative },
        });
        showToast(err instanceof Error ? err.message : "装饰性标记失败，请重试");
      }
    },
    [decorativeIds, showToast, updateItem],
  );

  /** 构造弹窗所需的确认项数据 */
  const writebackConfirmItems: WritebackConfirmItem[] = useMemo(
    () =>
      items
        .filter((item) => selectedIds.has(item.candidate.id))
        .map((item) => ({
          candidateId: item.candidate.id,
          altPlane: item.candidate.altPlane,
          isSharedFile: item.isSharedFile,
          usageCountPresent: item.target.usageCountPresent,
        })),
    [items, selectedIds],
  );

  /** 打开写回确认弹窗 */
  const openWritebackModal = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowWritebackModal(true);
  }, [selectedIds]);

  /** 关闭写回确认弹窗 */
  const closeWritebackModal = useCallback(() => {
    if (writingBack) return;
    setShowWritebackModal(false);
  }, [writingBack]);

  /** 确认写回 —— 调用 API */
  const confirmWriteback = useCallback(async () => {
    if (selectedIds.size === 0 || writingBack) return;

    setWritingBack(true);
    try {
      const response = await fetch("/api/writeback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateIds: Array.from(selectedIds) }),
      });

      if (response.status === 409) {
        /** 锁冲突 —— Toast 提示 */
        const body = await response.json().catch(() => ({} as Record<string, unknown>));
        const rejected = Array.isArray((body as Record<string, unknown>).rejected)
          ? (body.rejected as Array<{ candidateId: string; reason: string }>)
          : [];
        const parts = ["当前有其他操作进行中，请稍后重试。"];
        if (rejected.length > 0) {
          const reasons = rejected.map((r) => `${r.candidateId}: ${r.reason}`).join("；");
          parts.push(`跳过项：${reasons}`);
        }
        showToast(parts.join(" "));
        return;
      }

      if (!response.ok) {
        throw new Error(await readErrorMessage(response, `写回启动失败 (${response.status})`));
      }

      const result = (await response.json()) as {
        batchId: string;
        totalQueued: number;
        rejected: Array<{ candidateId: string; reason: string }>;
      };

      /** 有 rejected 项 → Toast 列出跳过原因 */
      if (result.rejected.length > 0) {
        const reasons = result.rejected.map((r) => `${r.candidateId}: ${r.reason}`).join("；");
        showToast(`写回已启动，但有 ${result.rejected.length} 项被跳过：${reasons}`);
      } else {
        showToast("写回任务已启动", "success");
      }

      setSelectedIds(new Set());
      setShowWritebackModal(false);
      setActiveBatchId(result.batchId);
      setBatchParam(result.batchId);
      void loadBatchDetail(result.batchId);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "写回启动失败，请重试");
    } finally {
      setWritingBack(false);
    }
  }, [selectedIds, showToast, writingBack]);

  const retryCandidates = useCallback(
    (candidateIds: string[]) => {
      if (candidateIds.length === 0) return;
      setSelectedIds(new Set(candidateIds));
      setShowWritebackModal(true);
    },
    [],
  );

  const failedItems = useMemo(
    () => items.filter((item) => item.candidate.status === "WRITEBACK_FAILED_RETRYABLE"),
    [items],
  );

  const selectedCount = selectedIds.size;
  const pageInfo = useMemo(
    () => `${meta.page.toLocaleString("zh-CN")} / ${meta.totalPages.toLocaleString("zh-CN")}`,
    [meta.page, meta.totalPages],
  );

  return (
    <>
      <s-page heading="审阅列表">
        <s-section heading="筛选">
          <div className={styles.toolbar}>
            <div className={styles.field}>
              <s-text tone="neutral">图片类型</s-text>
              <div className={styles.segmented} role="tablist" aria-label="图片类型筛选">
                {ALT_PLANE_OPTIONS.map((option) => (
                  <button
                    key={option.value || "ALL"}
                    type="button"
                    className={`${styles.segmentButton} ${
                      selectedAltPlane === option.value ? styles.segmentButtonActive : ""
                    }`}
                    onClick={() => setFilter({ altPlane: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className={styles.field}>
              <s-text tone="neutral">状态</s-text>
              <select
                className={styles.select}
                value={selectedStatus}
                onChange={(event) =>
                  setFilter({ status: event.currentTarget.value as StatusFilter })
                }
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value || "ALL"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {error && (
            <div className={styles.errorBox}>
              <s-text tone="critical">{error}</s-text>
            </div>
          )}
        </s-section>

        <s-section heading="草稿">
          {loading ? (
            <div className={styles.emptyBox}>
              <s-text tone="neutral">正在加载审阅项...</s-text>
            </div>
          ) : items.length === 0 ? (
            <div className={styles.emptyBox}>
              <s-stack direction="block" gap="small">
                <s-heading>暂无可审阅草稿</s-heading>
                <s-text tone="neutral">当前筛选条件下没有已生成的候选数据。</s-text>
              </s-stack>
            </div>
          ) : (
            <s-stack direction="block" gap="base">
              <div className={styles.listHeader}>
                <label className={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectPage}
                    aria-label="选择当前页全部审阅项"
                  />
                  <span>全选当页</span>
                </label>
                <s-text tone="neutral">
                  共 {meta.total.toLocaleString("zh-CN")} 条
                </s-text>
              </div>

              <div className={styles.list}>
                {items.map((item) => {
                  const candidateId = item.candidate.id;
                  const isDecorative = decorativeIds.has(candidateId);
                  const isSaving = savingIds.has(candidateId);
                  const draftText = draftValues[candidateId] ?? item.displayText;

                  return (
                    <article key={candidateId} className={styles.card}>
                      <div className={styles.row}>
                        <input
                          type="checkbox"
                          className={styles.itemCheckbox}
                          checked={selectedIds.has(candidateId)}
                          onChange={() => toggleSelect(candidateId)}
                          aria-label={`选择 ${getPrimaryUsageTitle(item)}`}
                        />

                        {item.target.thumbnailUrl ? (
                          <img
                            className={styles.thumbnail}
                            src={item.target.thumbnailUrl}
                            alt=""
                            loading="lazy"
                          />
                        ) : (
                          <div className={styles.thumbnailFallback}>No image</div>
                        )}

                        <div className={styles.content}>
                          <div className={styles.meta}>
                            <span className={`${styles.badge} ${styles[`plane_${item.candidate.altPlane}`]}`}>
                              {ALT_PLANE_LABELS[item.candidate.altPlane]}
                            </span>
                            <span className={`${styles.badge} ${styles[`status_${item.candidate.status}`]}`}>
                              {STATUS_LABELS[item.candidate.status]}
                            </span>
                            {isDecorative && (
                              <span className={`${styles.badge} ${styles.decorativeBadge}`}>
                                装饰性图片，不写回
                              </span>
                            )}
                          </div>

                          <div className={styles.titleBlock}>
                            <s-heading>{getPrimaryUsageTitle(item)}</s-heading>
                            <s-text tone="neutral">
                              {getPrimaryUsageMeta(item.target.primaryUsage)}
                            </s-text>
                          </div>

                          {item.isSharedFile && (
                            <div
                              className={styles.sharedNotice}
                              title={`此文件在 ${item.target.usageCountPresent.toLocaleString("zh-CN")} 个位置使用，写回将全局生效`}
                            >
                              <span aria-hidden="true">!</span>
                              <s-text>
                                此文件在 {item.target.usageCountPresent.toLocaleString("zh-CN")} 个位置使用，写回将全局生效
                              </s-text>
                            </div>
                          )}

                          <div className={styles.textGrid}>
                            <div className={styles.readonlyText}>
                              <s-text tone="neutral">AI 草稿</s-text>
                              <p>{item.draft?.aiGeneratedText || "无 AI 草稿"}</p>
                            </div>

                            <label className={styles.editorField}>
                              <span>编辑后文本</span>
                              <textarea
                                className={styles.editor}
                                value={draftText}
                                disabled={isDecorative || isSaving}
                                maxLength={512}
                                rows={3}
                                onChange={(event) =>
                                  setDraftValues((current) => ({
                                    ...current,
                                    [candidateId]: event.currentTarget.value,
                                  }))
                                }
                                onBlur={() => void saveDraft(item)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" && !event.shiftKey) {
                                    event.preventDefault();
                                    event.currentTarget.blur();
                                  }
                                }}
                              />
                            </label>
                          </div>
                        </div>

                        <div className={styles.sideActions}>
                          <label className={styles.switchLabel}>
                            <input
                              type="checkbox"
                              checked={isDecorative}
                              onChange={() => void toggleDecorative(item)}
                            />
                            <span>装饰性</span>
                          </label>
                          {isSaving && <span className={styles.savingText}>保存中</span>}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>

              <div className={styles.pagination}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={meta.page <= 1}
                  onClick={() => setFilter({ page: meta.page - 1 })}
                >
                  上一页
                </button>
                <s-text tone="neutral">{pageInfo}</s-text>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={meta.page >= meta.totalPages}
                  onClick={() => setFilter({ page: meta.page + 1 })}
                >
                  下一页
                </button>
              </div>
            </s-stack>
          )}
        </s-section>

        {effectiveProgress && (
          <s-section heading="写回进度">
            <div className={styles.progressPanel}>
              <s-stack direction="block" gap="base">
                <div className={styles.progressHeader}>
                  <s-heading>
                    {BATCH_STATUS_LABELS[effectiveProgress.status] ?? effectiveProgress.status}
                  </s-heading>
                  <s-text tone="neutral">
                    {writebackSSE.connected ? "实时连接中" : batchLoading ? "正在恢复状态" : "等待进度更新"}
                  </s-text>
                </div>
                <ProgressBar
                  percent={writebackPercent}
                  animated={!isTerminalBatch(effectiveProgress.status)}
                  size="large"
                />
                <div className={styles.progressStats}>
                  <span>已完成 {(
                    effectiveProgress.success +
                    effectiveProgress.fail +
                    effectiveProgress.skip
                  ).toLocaleString("zh-CN")}/{effectiveProgress.total.toLocaleString("zh-CN")}</span>
                  <span>成功 {effectiveProgress.success.toLocaleString("zh-CN")}</span>
                  <span>跳过 {effectiveProgress.skip.toLocaleString("zh-CN")}</span>
                  <span>失败 {effectiveProgress.fail.toLocaleString("zh-CN")}</span>
                  <span>待处理 {effectiveProgress.pending.toLocaleString("zh-CN")}</span>
                </div>
                {writebackSSE.error && (
                  <s-text tone="caution">{writebackSSE.error}</s-text>
                )}
              </s-stack>
            </div>
          </s-section>
        )}

        {batchDetail?.isTerminal && (
          <s-section heading="写回汇总">
            <div className={`${styles.summaryPanel} ${
              batchDetail.fail > 0 ? styles.summaryPanelCaution : styles.summaryPanelSuccess
            }`}>
              <s-stack direction="block" gap="base">
                <s-heading>
                  {batchDetail.fail > 0 ? "写回已结束，存在失败项" : "写回已全部完成"}
                </s-heading>
                <div className={styles.summaryStats}>
                  <div><strong>{batchDetail.total}</strong><span>总数</span></div>
                  <div><strong>{batchDetail.success}</strong><span>成功</span></div>
                  <div><strong>{batchDetail.skip}</strong><span>跳过</span></div>
                  <div><strong>{batchDetail.fail}</strong><span>失败</span></div>
                </div>
                <s-text tone="neutral">
                  耗时 {formatDuration(batchDetail.durationMs)}
                </s-text>
                {batchDetail.typeStats.length > 0 && (
                  <div className={styles.typeStats}>
                    {batchDetail.typeStats.map((stat) => (
                      <s-text key={stat.altPlane} tone="neutral">
                        {ALT_PLANE_LABELS[stat.altPlane]}：成功 {stat.success}，跳过 {stat.skip}，失败 {stat.fail}
                      </s-text>
                    ))}
                  </div>
                )}
                <div className={styles.summaryActions}>
                  {batchDetail.fail > 0 && (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => {
                        document.getElementById("writeback-failures")?.scrollIntoView({ behavior: "smooth" });
                      }}
                    >
                      查看失败项
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => window.location.assign("/app/history")}
                  >
                    查看写回历史
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => {
                      setActiveBatchId(null);
                      setBatchDetail(null);
                      setBatchParam(null);
                    }}
                  >
                    返回审阅列表
                  </button>
                </div>
              </s-stack>
            </div>
          </s-section>
        )}

        {failedItems.length > 0 && (
          <s-section heading="写回失败项">
            <div id="writeback-failures" className={styles.failurePanel}>
              <div className={styles.failureHeader}>
                <s-text tone="critical">
                  {failedItems.length.toLocaleString("zh-CN")} 项写回失败，可选择后重试。
                </s-text>
                <button
                  type="button"
                  className={styles.primaryButton}
                  onClick={() => retryCandidates(failedItems.map((item) => item.candidate.id))}
                >
                  重试全部失败项
                </button>
              </div>
              <div className={styles.failureList}>
                {failedItems.map((item) => (
                  <article key={item.candidate.id} className={styles.failureItem}>
                    {item.target.thumbnailUrl ? (
                      <img className={styles.failureThumb} src={item.target.thumbnailUrl} alt="" loading="lazy" />
                    ) : (
                      <div className={styles.failureThumbFallback}>No image</div>
                    )}
                    <div className={styles.failureContent}>
                      <div className={styles.meta}>
                        <span className={`${styles.badge} ${styles[`plane_${item.candidate.altPlane}`]}`}>
                          {ALT_PLANE_LABELS[item.candidate.altPlane]}
                        </span>
                        <span className={`${styles.badge} ${styles.status_WRITEBACK_FAILED_RETRYABLE}`}>
                          写回失败
                        </span>
                        <span className={styles.badge}>
                          重试 {item.candidate.retryCount}/3
                        </span>
                      </div>
                      <s-heading>{getPrimaryUsageTitle(item)}</s-heading>
                      <s-text tone="neutral">
                        {getPrimaryUsageMeta(item.target.primaryUsage)}
                      </s-text>
                      <s-text tone="critical">
                        {truncateText(item.candidate.errorMessage)}
                      </s-text>
                      {item.candidate.retryCount >= 3 && (
                        <s-text tone="caution">
                          已重试 3 次仍失败，建议联系支持或手动处理。
                        </s-text>
                      )}
                    </div>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => retryCandidates([item.candidate.id])}
                    >
                      重试
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </s-section>
        )}
      </s-page>

      {selectedCount > 0 && (
        <div className={styles.actionBar}>
          <span>已选 {selectedCount.toLocaleString("zh-CN")} 项</span>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={writingBack}
            onClick={openWritebackModal}
          >
            {writingBack ? "启动中..." : "写回选中项"}
          </button>
        </div>
      )}

      {/* 写回确认弹窗 */}
      <WritebackConfirmModal
        open={showWritebackModal}
        selectedItems={writebackConfirmItems}
        loading={writingBack}
        onConfirm={() => void confirmWriteback()}
        onCancel={closeWritebackModal}
      />

      {toast && (
        <div className={`${styles.toast} ${toast.tone === "success" ? styles.toastSuccess : ""}`}>
          <s-text tone={toast.tone}>{toast.message}</s-text>
        </div>
      )}
    </>
  );
}
