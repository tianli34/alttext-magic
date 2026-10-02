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