/**
 * File: server/modules/decorative/decorative.types.ts
 * Purpose: 装饰性标记 API 的返回体与错误类型。
 */
import type { AltCandidateStatus, CandidateGroupType } from "@prisma/client";

export interface DecorativeCandidateSummary {
  altCandidateId: string;
  altTargetId: string;
  status: AltCandidateStatus;
  decorativeActive: boolean;
  currentAltEmpty: boolean;
  groupTypes: CandidateGroupType[];
  updatedAt: string;
}

export type DecorativeActionErrorCode =
  | "NOT_FOUND"
  | "OUT_OF_SCOPE"
  | "INVALID_STATUS";

export class DecorativeActionError extends Error {
  readonly code: DecorativeActionErrorCode;
  readonly status: number;

  constructor(
    code: DecorativeActionErrorCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "DecorativeActionError";
    this.code = code;
    this.status = status;
  }
}
