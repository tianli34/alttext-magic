/**
 * File: server/modules/writeback/writeback.types.ts
 * Purpose: 写回 mutation 服务层公共类型。
 */

import type { Session } from "@shopify/shopify-api";

/**
 * 写回失败的结构化错误码。
 * AUTH_FAILED：Shopify 认证/授权失效（HTTP 401/403 或 GraphQL ACCESS_DENIED），
 * 在店铺重新授权前重试必然失败，processor 据此将候选落入终态。
 */
export type WritebackErrorCode = "AUTH_FAILED";

export type WritebackResult =
  | { success: true }
  | {
      success: false;
      error: string;
      retryable: boolean;
      /** 结构化错误码；缺省时由 processor 归为 WRITEBACK_FAILED */
      errorCode?: WritebackErrorCode;
    };

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

export interface ShopifyGraphqlError {
  message: string;
  extensions?: {
    code?: string;
  };
}

export interface ShopifyGraphqlResponse<TData> {
  data?: TData;
  errors?: ShopifyGraphqlError[];
}

export type ShopifyGraphqlExecutor = <TData>(
  params: {
    session: Session;
    query: string;
    variables: Record<string, unknown>;
    cost?: number;
  },
) => Promise<ShopifyGraphqlResponse<TData>>;
