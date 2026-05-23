/**
 * File: server/modules/generation/draft.service.ts
 * Purpose: 草稿编辑服务，处理 alt_draft.edited_text 的更新逻辑。
 *
 * 业务规则：
 * 1. candidateId 必须存在且属于当前 shop
 * 2. candidate 必须有关联的 draft
 * 3. candidate.status 必须为 GENERATED 或 WRITEBACK_FAILED_RETRYABLE
 */
import { AltCandidateStatus } from "@prisma/client";
import prisma from "../../db/prisma.server";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "draft.service" });

/** 允许编辑草稿的 candidate 状态集合 */
export const EDITABLE_STATUSES: ReadonlySet<AltCandidateStatus> = new Set([
  AltCandidateStatus.GENERATED,
  AltCandidateStatus.WRITEBACK_FAILED_RETRYABLE,
]);

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/** 草稿更新错误码 */
export type DraftUpdateErrorCode =
  | "CANDIDATE_NOT_FOUND"
  | "NO_DRAFT"
  | "INVALID_STATUS";

/** 草稿更新业务错误 */
export class DraftUpdateError extends Error {
  readonly code: DraftUpdateErrorCode;
  readonly status: number;

  constructor(code: DraftUpdateErrorCode, message: string, status: number) {
    super(message);
    this.name = "DraftUpdateError";
    this.code = code;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// 数据访问接口（可注入，方便测试）
// ---------------------------------------------------------------------------

/** 候选 + 草稿查询结果行 */
export interface CandidateDraftRow {
  id: string;
  shopId: string;
  status: AltCandidateStatus;
  draft: { id: string; editedText: string | null; updatedAt: Date } | null;
}

/** 更新后的草稿返回 */
export interface UpdatedDraftResult {
  id: string;
  editedText: string;
  updatedAt: Date;
}

/** 数据访问接口 */
export interface DraftUpdateDataAccess {
  /** 按 shopId + candidateId 查找候选及其关联草稿 */
  getCandidateWithDraft(
    shopId: string,
    candidateId: string,
  ): Promise<CandidateDraftRow | null>;

  /** 更新草稿编辑文本 */
  updateDraftEditedText(
    draftId: string,
    editedText: string,
  ): Promise<UpdatedDraftResult>;
}

// ---------------------------------------------------------------------------
// Prisma 实现
// ---------------------------------------------------------------------------

function createPrismaDataAccess(): DraftUpdateDataAccess {
  return {
    async getCandidateWithDraft(shopId, candidateId) {
      return prisma.altCandidate.findFirst({
        where: { id: candidateId, shopId },
        select: {
          id: true,
          shopId: true,
          status: true,
          draft: {
            where: { expiresAt: { gt: new Date() } },
            select: { id: true, editedText: true, updatedAt: true },
          },
        },
      });
    },

    async updateDraftEditedText(draftId, editedText) {
      const updated = await prisma.altDraft.update({
        where: { id: draftId },
        data: { editedText },
        select: { id: true, editedText: true, updatedAt: true },
      });
      return { ...updated, editedText: updated.editedText! };
    },
  };
}

// ---------------------------------------------------------------------------
// 核心业务逻辑
// ---------------------------------------------------------------------------

/**
 * 更新草稿的编辑文本。
 *
 * @param shopId      当前店铺 ID
 * @param candidateId 候选 ID（请求体中的 candidateId）
 * @param editedText  用户编辑后的文本
 * @param dataAccess  数据访问层（默认使用 Prisma 实现）
 * @returns 更新后的草稿数据
 * @throws {DraftUpdateError} 候选不存在 / 无草稿 / 状态不允许
 */
export async function updateDraftEditedText(
  shopId: string,
  candidateId: string,
  editedText: string,
  dataAccess: DraftUpdateDataAccess = createPrismaDataAccess(),
): Promise<UpdatedDraftResult> {
  // 1. 查找候选及其草稿
  const candidate = await dataAccess.getCandidateWithDraft(
    shopId,
    candidateId,
  );

  if (!candidate) {
    throw new DraftUpdateError(
      "CANDIDATE_NOT_FOUND",
      "候选不存在或不属于当前店铺",
      404,
    );
  }

  // 2. 确认关联草稿存在
  if (!candidate.draft) {
    throw new DraftUpdateError(
      "NO_DRAFT",
      "该候选尚无关联草稿",
      404,
    );
  }

  // 3. 校验 candidate 状态是否允许编辑
  if (!EDITABLE_STATUSES.has(candidate.status)) {
    throw new DraftUpdateError(
      "INVALID_STATUS",
      `当前状态 ${candidate.status} 不允许编辑，仅支持 GENERATED 和 WRITEBACK_FAILED_RETRYABLE`,
      409,
    );
  }

  // 4. 执行更新
  const updated = await dataAccess.updateDraftEditedText(
    candidate.draft.id,
    editedText,
  );

  logger.info(
    { candidateId, draftId: updated.id },
    "草稿编辑文本已更新",
  );

  return updated;
}
