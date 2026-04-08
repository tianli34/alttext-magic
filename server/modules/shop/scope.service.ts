/**
 * File: server/modules/shop/scope.service.ts
 * Purpose: Centralize the canonical JSON scope state persisted in the shops
 * table so server-side writes stay aligned with Prisma and frontend helpers.
 */
import {
  DEFAULT_SCOPE_FLAG_STATE,
  normalizeScopeFlagState,
} from "../../../app/lib/scope-utils";
import type { ScanScopeFlags } from "./shop.types";

export const DEFAULT_SCAN_SCOPE_FLAGS: ScanScopeFlags = {
  ...DEFAULT_SCOPE_FLAG_STATE,
};

export function normalizeScanScopeFlags(input: unknown): ScanScopeFlags {
  return normalizeScopeFlagState(input);
}
