/**
 * File: server/modules/scan/catalog/shopify-bulk.client.server.ts
 * Purpose: 封装 Shopify Admin GraphQL Bulk 查询相关调用。
 */
import prisma from "../../../db/prisma.server";
import { decryptToken } from "../../../crypto/token-encryption";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "shopify-bulk-client" });
const SHOPIFY_ADMIN_API_VERSION = "2026-04";

// 单次 Shopify Admin GraphQL 请求的网络超时（覆盖 undici 默认 10s connect timeout）。
const SHOPIFY_HTTP_TIMEOUT_MS = 15_000;
// 网络层瞬时错误的最大重试次数。HTTP 4xx/5xx 与 GraphQL userErrors 属确定性失败，不重试。
const SHOPIFY_HTTP_MAX_ATTEMPTS = 3;
// 指数退避基数：第 1 次重试 400ms，第 2 次 800ms。
const SHOPIFY_HTTP_BACKOFF_BASE_MS = 400;

/**
 * 判定某次 fetch 失败是否属于「可重试的网络层瞬时错误」。
 * 仅覆盖连接/超时/重置等网络异常；HTTP 状态码错误与 GraphQL userErrors 不在此列。
 * undici 的 fetch 网络失败统一表现为 TypeError('fetch failed')，真实原因挂在 error.cause 上。
 */
function isRetryableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const chain: Error[] = [error];
  if (error.cause instanceof Error) {
    chain.push(error.cause);
  }
  return chain.some((e) => {
    const name = e.name ?? "";
    const code = (e as { code?: string }).code ?? "";
    if (name === "TimeoutError" || name === "ConnectTimeoutError") return true;
    if (name.startsWith("UND_ERR")) return true;
    if (
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNABORTED",
        "EPIPE",
        "EPROTO",
      ].includes(code)
    ) {
      return true;
    }
    // fetch 统一封装的网络错误
    if (error.message === "fetch failed") return true;
    return false;
  });
}

/**
 * 对 Shopify Admin GraphQL 端点发起请求，仅在网络层瞬时失败时按指数退避重试。
 * 调用方仍需自行处理 HTTP 状态码与 GraphQL userErrors（这些不会被重试）。
 */
async function fetchShopifyAdmin(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SHOPIFY_HTTP_MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.timeout(SHOPIFY_HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal });
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error)) {
        throw error;
      }
      if (attempt < SHOPIFY_HTTP_MAX_ATTEMPTS) {
        const delayMs = SHOPIFY_HTTP_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        logger.warn(
          { attempt, maxAttempts: SHOPIFY_HTTP_MAX_ATTEMPTS, delayMs, err: error },
          "shopify-bulk.fetch-retry",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

interface ShopifyGraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

export interface ShopifyBulkUserError {
  field: string[] | null;
  message: string;
  code?: string | null;
}

export interface ShopifyBulkOperationSnapshot {
  id: string;
  status: string;
  errorCode: string | null;
  url: string | null;
  partialDataUrl: string | null;
  /** 查询根节点已处理对象的运行计数，用于发现阶段不确定进度展示 */
  objectCount: number;
  createdAt: string;
  completedAt: string | null;
}

async function getShopAdminContext(shopId: string): Promise<{
  shopDomain: string;
  accessToken: string;
}> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      shopDomain: true,
      accessTokenEncrypted: true,
      accessTokenNonce: true,
      accessTokenTag: true,
    },
  });

  if (!shop) {
    throw new Error(`Shop not found: ${shopId}`);
  }

  return {
    shopDomain: shop.shopDomain,
    accessToken: decryptToken(
      shop.accessTokenEncrypted,
      shop.accessTokenNonce,
      shop.accessTokenTag,
    ),
  };
}

async function executeShopifyAdminGraphql<TData>(
  shopId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<TData> {
  const { shopDomain, accessToken } = await getShopAdminContext(shopId);
  const response = await fetchShopifyAdmin(
    `https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  const payload = (await response.json()) as ShopifyGraphqlResponse<TData>;

  if (!response.ok) {
    throw new Error(
      `Shopify Admin GraphQL request failed: ${response.status} ${response.statusText}`,
    );
  }

  if (payload.errors && payload.errors.length > 0) {
    throw new Error(
      `Shopify Admin GraphQL returned errors: ${payload.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  if (!payload.data) {
    throw new Error("Shopify Admin GraphQL response is missing data");
  }

  return payload.data;
}

interface BulkOperationRunQueryResult {
  bulkOperationRunQuery: {
    bulkOperation: {
      id: string;
      status: string;
      createdAt: string;
    } | null;
    userErrors: ShopifyBulkUserError[];
  };
}

interface BulkOperationsListResult {
  bulkOperations: {
    edges: Array<{
      node: {
        id: string;
        status: string;
        createdAt: string;
      };
    }>;
  };
}

interface BulkOperationByIdResult {
  bulkOperation:
    | (Omit<ShopifyBulkOperationSnapshot, "objectCount"> & {
        objectCount: string | number | null;
      })
    | null;
}

export async function runBulkOperationQuery(
  shopId: string,
  bulkQuery: string,
): Promise<BulkOperationRunQueryResult["bulkOperationRunQuery"]> {
  const data = await executeShopifyAdminGraphql<BulkOperationRunQueryResult>(
    shopId,
    `
      mutation RunBulkOperation($query: String!) {
        bulkOperationRunQuery(query: $query) {
          bulkOperation {
            id
            status
            createdAt
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    { query: bulkQuery },
  );

  return data.bulkOperationRunQuery;
}

export async function listRunningBulkQueryOperations(
  shopId: string,
): Promise<ShopifyBulkOperationSnapshot[]> {
  const data = await executeShopifyAdminGraphql<BulkOperationsListResult>(
    shopId,
    `
      query ListBulkOperations {
        bulkOperations(first: 10, query: "type:QUERY") {
          edges {
            node {
              id
              status
              createdAt
            }
          }
        }
      }
    `,
  );

  return data.bulkOperations.edges
    .map((edge) => ({
      id: edge.node.id,
      status: edge.node.status,
      errorCode: null,
      url: null,
      partialDataUrl: null,
      objectCount: 0,
      createdAt: edge.node.createdAt,
      completedAt: null,
    }))
    .filter((operation) =>
      ["CREATED", "RUNNING"].includes(operation.status.toUpperCase()),
    );
}

export async function getBulkOperationById(
  shopId: string,
  bulkOperationId: string,
): Promise<ShopifyBulkOperationSnapshot | null> {
  const data = await executeShopifyAdminGraphql<BulkOperationByIdResult>(
    shopId,
    `
      query GetBulkOperation($id: ID!) {
        bulkOperation(id: $id) {
          id
          status
          errorCode
          url
          partialDataUrl
          objectCount
          createdAt
          completedAt
        }
      }
    `,
    { id: bulkOperationId },
  );

  if (!data.bulkOperation) {
    logger.warn({ shopId, bulkOperationId }, "shopify-bulk.bulk-operation-missing");
    return null;
  }

  // objectCount 为 UnsignedInt64（JSON 中以字符串返回），统一归一化为 number。
  return {
    ...data.bulkOperation,
    objectCount: Number(data.bulkOperation.objectCount) || 0,
  };
}
