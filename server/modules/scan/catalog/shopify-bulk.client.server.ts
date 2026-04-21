/**
 * File: server/modules/scan/catalog/shopify-bulk.client.server.ts
 * Purpose: 封装 Shopify Admin GraphQL Bulk 查询相关调用。
 */
import prisma from "../../../db/prisma.server";
import { decryptToken } from "../../../crypto/token-encryption";
import { createLogger } from "../../../utils/logger";

const logger = createLogger({ module: "shopify-bulk-client" });
const SHOPIFY_ADMIN_API_VERSION = "2026-04";

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
  const response = await fetch(
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
  bulkOperation: ShopifyBulkOperationSnapshot | null;
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
          createdAt
          completedAt
        }
      }
    `,
    { id: bulkOperationId },
  );

  if (!data.bulkOperation) {
    logger.warn({ shopId, bulkOperationId }, "shopify-bulk.bulk-operation-missing");
  }

  return data.bulkOperation;
}
