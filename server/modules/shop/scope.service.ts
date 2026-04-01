/**
 * File: server/modules/shop/scope.service.ts
 * Purpose: Centralize conversion between readable scan scope flags and the
 * compact bitmask persisted in the shops table.
 */
import type { ScanScopeFlags } from "./shop.types";

const PRODUCTS_FLAG = 1 << 0;
const FILES_FLAG = 1 << 1;
const COLLECTIONS_FLAG = 1 << 2;
const ARTICLES_FLAG = 1 << 3;

export const DEFAULT_SCAN_SCOPE_FLAGS: ScanScopeFlags = {
  products: true,
  files: true,
  collections: true,
  articles: true,
};

export function encodeScanScopeFlags(flags: ScanScopeFlags): number {
  let encoded = 0;

  if (flags.products) {
    encoded |= PRODUCTS_FLAG;
  }

  if (flags.files) {
    encoded |= FILES_FLAG;
  }

  if (flags.collections) {
    encoded |= COLLECTIONS_FLAG;
  }

  if (flags.articles) {
    encoded |= ARTICLES_FLAG;
  }

  return encoded;
}
