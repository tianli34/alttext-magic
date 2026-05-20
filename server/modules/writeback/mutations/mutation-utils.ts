/**
 * File: server/modules/writeback/mutations/mutation-utils.ts
 * Purpose: 写回 mutation 执行器共享的 Admin GraphQL 调用与错误分类工具。
 */

import type { Session } from "@shopify/shopify-api";
import { getShopifyRateLimiter } from "../../../shopify/shopify-rate-limiter.server";
import type {
  ShopifyGraphqlResponse,
  ShopifyUserError,
} from "../writeback.types";

const SHOPIFY_ADMIN_API_VERSION = "2026-04";

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
