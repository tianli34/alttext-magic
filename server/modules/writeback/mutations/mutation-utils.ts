/**
 * File: server/modules/writeback/mutations/mutation-utils.ts
 * Purpose: 写回 mutation 执行器共享的 Admin GraphQL 调用与错误分类工具。
 */

import type { Session } from "@shopify/shopify-api";
import { getShopifyRateLimiter } from "../../../shopify/shopify-rate-limiter.server";
import type {
  ShopifyGraphqlError,
  ShopifyGraphqlResponse,
  ShopifyUserError,
  WritebackResult,
} from "../writeback.types";

const SHOPIFY_ADMIN_API_VERSION = "2026-04";

/**
 * Shopify 认证/授权失效错误（HTTP 401/403）。
 * 与网络抖动/限流不同，令牌作废或权限不足在店铺重新授权前重试必然失败，
 * 因此单独成类以便执行器将其分类为不可重试。
 */
export class ShopifyAuthError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ShopifyAuthError";
    this.status = status;
  }
}

export async function executeShopifyGraphql<TData>(params: {
  session: Session;
  query: string;
  variables: Record<string, unknown>;
  cost?: number;
}): Promise<ShopifyGraphqlResponse<TData>> {
  const accessToken = params.session.accessToken;

  if (!accessToken) {
    throw new Error("Shopify session is missing an access token");
  }

  await getShopifyRateLimiter(params.session.shop).acquire(params.cost ?? 10);

  const response = await fetch(
    `https://${params.session.shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: params.query,
        variables: params.variables,
      }),
    },
  );

  // 401/403 属于认证/授权失效，须在通用 !response.ok 分支之前单独分类抛出
  if (response.status === 401 || response.status === 403) {
    const body = await response.text();
    throw new ShopifyAuthError(
      response.status,
      `Shopify Admin GraphQL auth error: ${response.status} ${response.statusText}: ${body}`,
    );
  }

  if (response.status === 429 || response.status >= 500) {
    throw new Error(
      `Shopify Admin GraphQL retryable HTTP error: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Shopify Admin GraphQL HTTP error: ${response.status} ${response.statusText}: ${body}`,
    );
  }

  return (await response.json()) as ShopifyGraphqlResponse<TData>;
}

export function formatUserErrors(errors: ShopifyUserError[]): string {
  return errors
    .map((error) => {
      const field = formatField(error.field);
      const code = error.code ? `[${error.code}] ` : "";
      return `${field}${code}${error.message}`;
    })
    .join("; ");
}

export function isRetryableUserError(error: ShopifyUserError): boolean {
  const code = error.code?.toUpperCase() ?? "";
  const message = error.message.toLowerCase();

  if (
    code.includes("INTERNAL") ||
    code.includes("TIMEOUT") ||
    code.includes("THROTTLED") ||
    code.includes("TOO_MANY") ||
    code.includes("PROCESSING") ||
    code.includes("NOT_READY")
  ) {
    return true;
  }

  return (
    message.includes("try again") ||
    message.includes("temporarily") ||
    message.includes("timeout") ||
    message.includes("throttl") ||
    message.includes("not ready") ||
    message.includes("processing")
  );
}

function formatField(field: ShopifyUserError["field"]): string {
  if (!field) return "";
  if (Array.isArray(field)) return field.length > 0 ? `${field.join(".")}: ` : "";
  return field.length > 0 ? `${field}: ` : "";
}

/** GraphQL 响应级错误（HTTP 200 + errors）中标识认证/授权失效的扩展码 */
const AUTH_DENIED_EXTENSION_CODE = "ACCESS_DENIED";

/** 判定 GraphQL 响应级错误是否为认证/授权失效 */
export function isAuthDeniedGraphqlError(error: ShopifyGraphqlError): boolean {
  return error.extensions?.code?.toUpperCase() === AUTH_DENIED_EXTENSION_CODE;
}

/**
 * 将 GraphQL errors 数组统一映射为写回失败结果。
 * 任一错误为 ACCESS_DENIED 时视为认证失效：不可重试 + AUTH_FAILED。
 */
export function toGraphqlErrorsFailure(
  errors: ShopifyGraphqlError[],
): Extract<WritebackResult, { success: false }> {
  const authDenied = errors.some(isAuthDeniedGraphqlError);
  return {
    success: false,
    error: errors.map((error) => error.message).join("; "),
    retryable: !authDenied,
    ...(authDenied ? { errorCode: "AUTH_FAILED" as const } : {}),
  };
}

/**
 * 将执行器捕获的未知异常统一分类为写回失败结果。
 * ShopifyAuthError（401/403）→ 不可重试 + AUTH_FAILED；其余异常维持可重试。
 */
export function toExecutorFailure(
  err: unknown,
): Extract<WritebackResult, { success: false }> {
  if (err instanceof ShopifyAuthError) {
    return {
      success: false,
      error: err.message,
      retryable: false,
      errorCode: "AUTH_FAILED",
    };
  }
  return {
    success: false,
    error: err instanceof Error ? err.message : String(err),
    retryable: true,
  };
}
