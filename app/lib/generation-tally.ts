/**
 * File: app/lib/generation-tally.ts
 * Purpose: 生成计数（汇总弹窗「生成结果」三项）的派生与解析工具。
 *
 *          为什么单独抽出：汇总里的「成功」并非服务端权威字段，而是由生成进度快照
 *          派生（与 worker 计数同口径：succeeded = total - skipped - failed）。
 *          该派生量原先只存活在 useGenerationFlow 的内存 ref 中，一旦刷新页面
 *          （恢复路径直接进 WRITEBACK 阶段，生成进度 SSE 不再激活）就必然丢失，
 *          表现为「生成成功 0 / 写回成功 94」这种自相矛盾的汇总。
 *          根因是「未知」被渲染成了「0」——因此这里集中派生逻辑，并把
 *          「无法取得（null）」与「确实为 0」显式区分开，供 Hook 与 UI 共用。
 *
 *          刷新恢复路径的计数回填循环（hydrateGenerationTallyWithRetry）同样集中
 *          在此：取数策略（重试直至成功）与 React 解耦，可脱离组件单独单测。
 */

/** 生成计数三元组，与 generation_batch 计数同口径 */
export interface GenerationTally {
  /** 总处理数 */
  total: number;
  /** 成功数（派生值） */
  succeeded: number;
  /** 跳过数（已有 Alt） */
  skipped: number;
  /** 失败数 */
  failed: number;
}

/** 派生所需的最小快照字段集（/api/generation/batch/:batchId 返回体为其超集） */
export interface GenerationTallySource {
  total: number;
  skipped: number;
  failed: number;
}

/**
 * 由生成进度快照派生计数。
 * succeeded 口径与 worker 完全一致：总处理数扣除跳过与失败；
 * 负数（计数尚未收敛时的瞬态）一律归零，避免界面出现负值。
 */
export function toGenerationTally(snapshot: GenerationTallySource): GenerationTally {
  const succeeded = snapshot.total - snapshot.skipped - snapshot.failed;

  return {
    total: snapshot.total,
    succeeded: succeeded > 0 ? succeeded : 0,
    skipped: snapshot.skipped,
    failed: snapshot.failed,
  };
}

/**
 * 校验轮询接口返回体是否可用于派生（字段齐全且类型正确）。
 * 不通过时调用方应保留「未知」语义，而不是退化成 0。
 */
export function isGenerationTallySnapshot(value: unknown): value is GenerationTallySource {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.total === "number" &&
    typeof candidate.skipped === "number" &&
    typeof candidate.failed === "number"
  );
}

/**
 * 校验持久化缓存或外部载荷是否为合法的 GenerationTally 结构。
 */
export function isGenerationTally(value: unknown): value is GenerationTally {
  if (typeof value !== "object" || value === null) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.total === "number" &&
    typeof candidate.succeeded === "number" &&
    typeof candidate.skipped === "number" &&
    typeof candidate.failed === "number"
  );
}

// ============================================================================
// 刷新恢复路径的计数回填循环
// ============================================================================

/** 默认重试间隔：与写回进度轮询兜底（useWritebackSSE 的 POLL_INTERVAL_MS）同间隔 */
export const GENERATION_TALLY_RETRY_DELAY_MS = 3_000;

/** 回填单次取数结果（与 fetch Response 对齐的最小接口，便于测试注入） */
export interface GenerationTallyFetchResult {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export interface HydrateGenerationTallyOptions {
  /** 单次取数（调用方负责鉴权令牌与 URL 拼装） */
  fetchSnapshot: () => Promise<GenerationTallyFetchResult>;
  /** 取数成功且校验通过后的落地回调（调用方写 ref / 原地补汇总） */
  onTally: (tally: GenerationTally) => void;
  /** 重试间隔毫秒数，默认 GENERATION_TALLY_RETRY_DELAY_MS */
  retryDelayMs?: number;
  /** 等待实现，默认 setTimeout；测试注入以避免真实等待 */
  delay?: (ms: number) => Promise<void>;
  /** 失效核对：teardown/重入后为 true 时循环立即退出；默认永不失效 */
  isCancelled?: () => boolean;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 刷新恢复路径的生成计数回填循环：失败静默，按固定间隔重试直至成功。
 *
 * 为什么重试直至成功：刷新后的首试常撞上 App Bridge 会话令牌重建或嵌入式
 * 鉴权 302→401 竞态（写回轮询兜底同样会撞上，但它按固定间隔重试所以从不
 * 缺席），此前「试一次、失败即放弃」的实现把「尚未取得」永久留成占位符，
 * 表现为「生成阶段计数未能取得」概率性出现。
 *
 * 退出条件（三选一）：
 * 1. 成功：200 且载荷通过 isGenerationTallySnapshot 校验 → onTally 后返回；
 * 2. 404：批次不存在或越权防护，确定性失败，重试无意义 → 保持「未知」返回；
 * 3. isCancelled() 为 true：teardown（cancel/closeSummary/组件卸载）或恢复
 *    effect 重入，旧循环立即退出。每次落状态前都核对，且核对与 onTally
 *    同处一个同步块——teardown 后不得再向已关闭的流程写入上一批次的计数。
 */
export async function hydrateGenerationTallyWithRetry(
  options: HydrateGenerationTallyOptions,
): Promise<void> {
  const {
    fetchSnapshot,
    onTally,
    retryDelayMs = GENERATION_TALLY_RETRY_DELAY_MS,
    delay = defaultDelay,
    isCancelled = () => false,
  } = options;

  for (;;) {
    if (isCancelled()) return;
    try {
      const response = await fetchSnapshot();
      if (isCancelled()) return;

      if (response.status === 404) return;

      if (response.ok) {
        const snapshot: unknown = await response.json();
        if (isCancelled()) return;
        if (isGenerationTallySnapshot(snapshot)) {
          onTally(toGenerationTally(snapshot));
          return;
        }
        // 200 但载荷不符合口径（如代理注入非 JSON 响应体）：按瞬态重试
      }
    } catch {
      // 静默：网络瞬断/令牌失败等瞬态，按节奏重试
    }
    await delay(retryDelayMs);
  }
}