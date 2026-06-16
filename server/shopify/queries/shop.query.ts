/**
 * File: server/shopify/queries/shop.query.ts
 * Purpose: Shopify Shop 级别的 GraphQL 查询。
 */

export const SHOP_TIMEZONE_QUERY = /* GraphQL */ `
  query ShopTimezone {
    shop {
      ianaTimezone
    }
  }
`;

export interface ShopTimezoneResponse {
  shop: {
    ianaTimezone: string;
  };
}
