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
];
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
export const EMPTY_SCOPE_FLAG_STATE = {
    PRODUCT_MEDIA: false,
    FILES: false,
    COLLECTION_IMAGE: false,
    ARTICLE_IMAGE: false,
};
export const DEFAULT_SCOPE_FLAG_STATE = {
    PRODUCT_MEDIA: true,
    FILES: true,
    COLLECTION_IMAGE: true,
    ARTICLE_IMAGE: true,
};
const scopeFlagOrderMap = new Map(SCOPE_FLAG_ORDER.map((flag, index) => [flag, index]));
export function isScopeFlag(value) {
    return scopeFlagSchema.safeParse(value).success;
}
export function dedupeScopeFlags(flags) {
    return [...new Set(flags)];
}
export function sortScopeFlags(flags) {
    return [...flags].sort((left, right) => {
        return scopeFlagOrderMap.get(left) - scopeFlagOrderMap.get(right);
    });
}
export function normalizeScopeFlags(flags) {
    return sortScopeFlags(dedupeScopeFlags(flags));
}
export function createScopeFlagState(flags) {
    const enabled = new Set(normalizeScopeFlags(flags));
    return {
        PRODUCT_MEDIA: enabled.has("PRODUCT_MEDIA"),
        FILES: enabled.has("FILES"),
        COLLECTION_IMAGE: enabled.has("COLLECTION_IMAGE"),
        ARTICLE_IMAGE: enabled.has("ARTICLE_IMAGE"),
    };
}
export function listEnabledScopeFlags(state) {
    return SCOPE_FLAG_ORDER.filter((flag) => state[flag]);
}
export function normalizeScopeFlagState(input) {
    const parsed = scopeFlagStateSchema.parse(input);
    return createScopeFlagState(listEnabledScopeFlags(parsed));
}
export function parseScopeFlags(input) {
    return normalizeScopeFlags(scopeFlagsSchema.parse(input));
}
export function parseScopeFlagState(input) {
    return normalizeScopeFlagState(input);
}
export function safeParseScopeFlags(input) {
    const result = scopeFlagsSchema.safeParse(input);
    if (!result.success) {
        return result;
    }
    return {
        success: true,
        data: normalizeScopeFlags(result.data),
    };
}
export function safeParseScopeFlagState(input) {
    const result = scopeFlagStateSchema.safeParse(input);
    if (!result.success) {
        return result;
    }
    return {
        success: true,
        data: normalizeScopeFlagState(result.data),
    };
}
