/**
 * File: server/modules/devtools/reset-pending-targets.core.server.ts
 * Purpose: [TEMP-DEVTOOLS] 「待生成生产器」的本地复位环节：把给定 Shopify MediaImage gid
 *          对应的 alt_target / alt_candidate 拉回「待生成」态，供生成链路反复回归测试。
 *
 *          口径与正式链路严格同构，避免造出「下次扫描就被推翻」的假数据：
 *            1) dashboard.service 的 pending 与 api.dashboard.process 的 generationCandidateIds
 *               都要求 alt_target.current_alt_empty = true + 非装饰性
 *               + INITIAL|GENERATION_FAILED_RETRYABLE;
 *            2) publish.service::computeNextCandidateState 在「alt 空 + 草稿(alt_draft)仍有效」时
 *               会把候选推导为 GENERATED(待写回)。因此必须删掉草稿, 否则增量收敛立刻把
 *               造好的「待生成」推回「待写回」。
 *          故本模块在一批一个事务内做三件事：清 alt_target 的 alt 快照 → 删 alt_draft
 *          → 候选置 INITIAL。
 *
 *          跳过规则(不破坏真实语义):
 *            - 装饰性标记仍激活的 target(商家设置, 且统计口径本就不算待生成);
 *            - 候选处于 GENERATING(不打断在跑的生成任务);
 *            - 本地查不到 target 的 gid(尚未扫描入库, 交给扫描链路自己收敛)。
 *
 *          仅覆盖 FILE_ALT 平面(产品图片与 Files 共用同一平面), 集合图与文章图不在本工具范围。
 *
 *          ⚠️ 临时性质: 生产上线前与 server/modules/devtools/ 目录一并删除。
 */
import {
  AltCandidateMissingReason,
  AltCandidateStatus,
  AltPlane,
} from "@prisma/client";
import prisma from "../../db/prisma.server";
import type { ClearMediaAltLog } from "./clear-media-alt.core.server";

/** 单次 IN 查询/事务处理的 gid 数量上限，避免超长 IN 子句 */
const CHUNK_SIZE = 500;

/** 分类输入行: alt_target 左连 decorative_mark / alt_candidate 后的投影 */
export interface PendingResetTargetRow {
  id: string;
  decorativeActive: boolean;
  candidateId: string | null;
  candidateStatus: AltCandidateStatus | null;
}

/** 分类结果: 纯函数产出, 供 DB 层按桶批量写 */
export interface PendingResetPlan {
  /** 需要复位的 alt_target id */
  targetIds: string[];
  /** 已有候选行的 target id（走 updateMany） */
  existingCandidateTargetIds: string[];
  /** 缺候选行的 target id（需补建 INITIAL 候选, 否则统计与一键处理都看不到它） */
  missingCandidateTargetIds: string[];
  /** 需要删除草稿的候选 id */
  candidateIds: string[];
  skippedDecorative: number;
  skippedGenerating: number;
}

/**
 * 把候选 target 行分成「可复位 / 装饰跳过 / 生成中跳过」三类（纯函数, 便于单测）。
 * 判定顺序即优先级: 装饰性 > 生成中 > 可复位。
 */
export function classifyPendingResetTargets(
  rows: readonly PendingResetTargetRow[],
): PendingResetPlan {
  const plan: PendingResetPlan = {
    targetIds: [],
    existingCandidateTargetIds: [],
    missingCandidateTargetIds: [],
    candidateIds: [],
    skippedDecorative: 0,
    skippedGenerating: 0,
  };

  for (const row of rows) {
    if (row.decorativeActive) {
      plan.skippedDecorative += 1;
      continue;
    }
    if (row.candidateStatus === AltCandidateStatus.GENERATING) {
      plan.skippedGenerating += 1;
      continue;
    }

    plan.targetIds.push(row.id);
    if (row.candidateId === null) {
      plan.missingCandidateTargetIds.push(row.id);
    } else {
      plan.existingCandidateTargetIds.push(row.id);
      plan.candidateIds.push(row.candidateId);
    }
  }

  return plan;
}

export interface ResetPendingTargetsInput {
  shopId: string;
  /** Shopify MediaImage gid 列表（= alt_target.write_target_id） */
  writeTargetIds: readonly string[];
  log?: ClearMediaAltLog;
}

export interface ResetPendingTargetsResult {
  /** 传入的 gid 数（去重后） */
  requestCount: number;
  /** 本地命中的 FILE_ALT target 数 */
  matchedTargets: number;
  /** 本地无 target（未扫描入库）的 gid 数 */
  missingTargets: number;
  /** 复位（含补建候选）的 target 数 */
  resetTargets: number;
  /** 被置回 INITIAL 的候选数 */
  resetCandidates: number;
  /** 补建的候选数 */
  createdCandidates: number;
  /** 删除的 alt_draft 数 */
  deletedDrafts: number;
  skippedDecorative: number;
  skippedGenerating: number;
}

/**
 * 候选行需要 lastSeenScanJobId（非空）才能补建，取值口径与
 * scan/productConvergence.ts::convergeProduct 一致：优先店铺上次发布任务, 否则任一扫描任务。
 */
async function resolveFallbackScanJobId(
  shopId: string,
): Promise<string | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { lastPublishedScanJobId: true },
  });
  if (shop?.lastPublishedScanJobId) {
    return shop.lastPublishedScanJobId;
  }

  const anyJob = await prisma.scanJob.findFirst({
    where: { shopId },
    select: { id: true },
  });
  return anyJob?.id ?? null;
}

/** 单批复位：一个事务内完成「删草稿 + 清 alt 快照 + 候选置 INITIAL(+补建)」 */
async function resetChunk(params: {
  shopId: string;
  chunk: string[];
  scanJobId: string | null;
}): Promise<{
  matched: number;
  plan: PendingResetPlan;
  resetCandidates: number;
  createdCandidates: number;
  deletedDrafts: number;
}> {
  const { shopId, chunk, scanJobId } = params;

  return prisma.$transaction(async (tx) => {
    const targets = await tx.altTarget.findMany({
      where: {
        shopId,
        altPlane: AltPlane.FILE_ALT,
        writeTargetId: { in: chunk },
      },
      select: {
        id: true,
        decorativeMark: { select: { isActive: true } },
        altCandidate: { select: { id: true, status: true } },
      },
    });

    const plan = classifyPendingResetTargets(
      targets.map((target) => ({
        id: target.id,
        decorativeActive: target.decorativeMark?.isActive === true,
        candidateId: target.altCandidate?.id ?? null,
        candidateStatus: target.altCandidate?.status ?? null,
      })),
    );

    let resetCandidates = 0;
    let createdCandidates = 0;
    let deletedDrafts = 0;

    if (plan.targetIds.length > 0) {
      // 1. 删草稿：草稿是「已生成待写回」的唯一凭据, 留着就会被收敛回 GENERATED
      if (plan.candidateIds.length > 0) {
        const drafts = await tx.altDraft.deleteMany({
          where: { altCandidateId: { in: plan.candidateIds } },
        });
        deletedDrafts = drafts.count;
      }

      // 2. 清 alt_target 的 alt 快照（与 Shopify 侧已清空的 alt 对齐）
      await tx.altTarget.updateMany({
        where: { id: { in: plan.targetIds } },
        data: { currentAltText: null, currentAltEmpty: true },
      });

      // 3. 候选置回 INITIAL（同时清掉写回时间/错误码, 避免旧批次残留干扰判断）
      if (plan.existingCandidateTargetIds.length > 0) {
        const candidates = await tx.altCandidate.updateMany({
          where: { altTargetId: { in: plan.existingCandidateTargetIds } },
          data: {
            status: AltCandidateStatus.INITIAL,
            missingReason: AltCandidateMissingReason.EMPTY,
            writtenAt: null,
            errorCode: null,
            errorMessage: null,
          },
        });
        resetCandidates = candidates.count;
      }

      // 4. 无候选行的 target（从未发布过）补建 INITIAL 候选, 否则统计/一键处理都取不到
      if (scanJobId !== null && plan.missingCandidateTargetIds.length > 0) {
        const created = await tx.altCandidate.createMany({
          data: plan.missingCandidateTargetIds.map((altTargetId) => ({
            shopId,
            altTargetId,
            status: AltCandidateStatus.INITIAL,
            missingReason: AltCandidateMissingReason.EMPTY,
            lastSeenScanJobId: scanJobId,
          })),
          skipDuplicates: true,
        });
        createdCandidates = created.count;
      }
    }

    return {
      matched: targets.length,
      plan,
      resetCandidates,
      createdCandidates,
      deletedDrafts,
    };
  });
}

/**
 * 执行本地复位：把 writeTargetIds 对应的 target/候选拉回「待生成」。
 * 分批(每批 CHUNK_SIZE 个 gid), 每批一个事务, 全程通过 log 回显进度。
 */
export async function resetTargetsToPendingGeneration(
  input: ResetPendingTargetsInput,
): Promise<ResetPendingTargetsResult> {
  const log: ClearMediaAltLog = input.log ?? ((line) => console.log(line));
  const uniqueIds = [...new Set(input.writeTargetIds)];

  const summary: ResetPendingTargetsResult = {
    requestCount: uniqueIds.length,
    matchedTargets: 0,
    missingTargets: 0,
    resetTargets: 0,
    resetCandidates: 0,
    createdCandidates: 0,
    deletedDrafts: 0,
    skippedDecorative: 0,
    skippedGenerating: 0,
  };

  if (uniqueIds.length === 0) {
    log("  ⚠️ 无待复位图片, 跳过本地复位。");
    return summary;
  }

  const scanJobId = await resolveFallbackScanJobId(input.shopId);
  if (scanJobId === null) {
    log("  ⚠️ 该店铺还没有任何扫描任务, 缺候选行的 target 无法补建(仅复位已有候选)。");
  }

  for (let start = 0; start < uniqueIds.length; start += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(start, start + CHUNK_SIZE);
    const batch = await resetChunk({
      shopId: input.shopId,
      chunk,
      scanJobId,
    });

    summary.matchedTargets += batch.matched;
    summary.missingTargets += chunk.length - batch.matched;
    summary.resetTargets += batch.plan.targetIds.length;
    summary.resetCandidates += batch.resetCandidates;
    summary.createdCandidates += batch.createdCandidates;
    summary.deletedDrafts += batch.deletedDrafts;
    summary.skippedDecorative += batch.plan.skippedDecorative;
    summary.skippedGenerating += batch.plan.skippedGenerating;

    log(
      `  ♻️ 批次 ${start + 1}-${start + chunk.length}: 命中 target ${batch.matched}, ` +
        `复位候选 ${batch.resetCandidates}(补建 ${batch.createdCandidates}), ` +
        `删草稿 ${batch.deletedDrafts}, ` +
        `跳过 装饰性 ${batch.plan.skippedDecorative}/生成中 ${batch.plan.skippedGenerating}`,
    );
  }

  return summary;
}

