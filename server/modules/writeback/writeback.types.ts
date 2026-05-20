/**
 * File: server/modules/writeback/writeback.types.ts
 * Purpose: 写回 mutation 服务层公共类型。
 */

import type { Session } from "@shopify/shopify-api";

export type WritebackResult =
  | { success: true }
  | { success: false; error: string; retryable: boolean };

export interface MutationExecutor {
  execute(params: {
    session: Session;
    shopifyGid: string;
    altText: string;
  }): Promise<WritebackResult>;
}

export interface ShopifyUserError {
  field?: string[] | string | null;
  message: string;
  code?: string | null;
}

export interface ShopifyGraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{
    message: string;
    extensions?: {
      code?: string;
    };
  }>;
}

export type ShopifyGraphqlExecutor = <TData>(
  params: {
    session: Session;
    query: string;
    variables: Record<string, unknown>;
    cost?: number;
  },
) => Promise<ShopifyGraphqlResponse<TData>>;
