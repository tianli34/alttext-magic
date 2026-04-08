/**
 * File: server/modules/shop/shop.types.ts
 * Purpose: Define the server-side types used for shop initialization and
 * offline token persistence after Shopify authentication.
 */
import type { ScopeFlagState } from "../../../app/lib/scope-utils";

export type ScanScopeFlags = ScopeFlagState;

export interface ShopifySessionSnapshot {
  id: string;
  shop: string;
  isOnline: boolean;
  accessToken?: string;
  scope?: string | null;
}

export interface PersistOfflineShopSessionInput {
  session: ShopifySessionSnapshot;
}
