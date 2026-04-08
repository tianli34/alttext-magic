/**
 * File: app/lib/scope-utils.ts
 * Purpose: Provide client-safe helpers to validate, de-duplicate, and sort
 * scan scope flags plus a canonical JSON object shape shared by forms, APIs,
 * and Prisma persistence.
 */
import { z } from "zod";

export const SCOPE_FLAG_ORDER = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
] as const;

export type ScopeFlag = (typeof SCOPE_FLAG_ORDER)[number];
export type ScopeFlagState = Record<ScopeFlag, boolean>;

export const scopeFlagSchema = z.enum(SCOPE_FLAG_ORDER);
export const scopeFlagsSchema = z.array(scopeFlagSchema);
export const scopeFlagStateSchema = z
  .object({
    PRODUCT_MEDIA: z.boolean(),
    FILES: z.boolean(),
    COLLECTION_IMAGE: z.boolean(),
    ARTICLE_IMAGE: z.boolean(),
  })
  .strict();

export const EMPTY_SCOPE_FLAG_STATE: ScopeFlagState = {
  PRODUCT_MEDIA: false,
  FILES: false,
  COLLECTION_IMAGE: false,
  ARTICLE_IMAGE: false,
};

export const DEFAULT_SCOPE_FLAG_STATE: ScopeFlagState = {
  PRODUCT_MEDIA: true,
  FILES: true,
  COLLECTION_IMAGE: true,
  ARTICLE_IMAGE: true,
};

const scopeFlagOrderMap = new Map<ScopeFlag, number>(
  SCOPE_FLAG_ORDER.map((flag, index) => [flag, index]),
);

export function isScopeFlag(value: unknown): value is ScopeFlag {
  return scopeFlagSchema.safeParse(value).success;
}

export function dedupeScopeFlags(flags: readonly ScopeFlag[]): ScopeFlag[] {
  return [...new Set(flags)];
}

export function sortScopeFlags(flags: readonly ScopeFlag[]): ScopeFlag[] {
  return [...flags].sort((left, right) => {
    return scopeFlagOrderMap.get(left)! - scopeFlagOrderMap.get(right)!;
  });
}

export function normalizeScopeFlags(flags: readonly ScopeFlag[]): ScopeFlag[] {
  return sortScopeFlags(dedupeScopeFlags(flags));
}

export function createScopeFlagState(
  flags: readonly ScopeFlag[],
): ScopeFlagState {
  const enabled = new Set(normalizeScopeFlags(flags));

  return {
    PRODUCT_MEDIA: enabled.has("PRODUCT_MEDIA"),
    FILES: enabled.has("FILES"),
    COLLECTION_IMAGE: enabled.has("COLLECTION_IMAGE"),
    ARTICLE_IMAGE: enabled.has("ARTICLE_IMAGE"),
  };
}

export function listEnabledScopeFlags(state: ScopeFlagState): ScopeFlag[] {
  return SCOPE_FLAG_ORDER.filter((flag) => state[flag]);
}

export function normalizeScopeFlagState(input: unknown): ScopeFlagState {
  const parsed = scopeFlagStateSchema.parse(input);

  return createScopeFlagState(listEnabledScopeFlags(parsed));
}

export function parseScopeFlags(input: unknown): ScopeFlag[] {
  return normalizeScopeFlags(scopeFlagsSchema.parse(input));
}

export function parseScopeFlagState(input: unknown): ScopeFlagState {
  return normalizeScopeFlagState(input);
}

export function safeParseScopeFlags(input: unknown):
  | { success: true; data: ScopeFlag[] }
  | { success: false; error: z.ZodError<unknown> } {
  const result = scopeFlagsSchema.safeParse(input);

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    data: normalizeScopeFlags(result.data),
  };
}

export function safeParseScopeFlagState(input: unknown):
  | { success: true; data: ScopeFlagState }
  | { success: false; error: z.ZodError<unknown> } {
  const result = scopeFlagStateSchema.safeParse(input);

  if (!result.success) {
    return result;
  }

  return {
    success: true,
    data: normalizeScopeFlagState(result.data),
  };
}
