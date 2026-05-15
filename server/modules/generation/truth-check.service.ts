/**
 * File: server/modules/generation/truth-check.service.ts
 * Purpose: 真值复核服务（TruthCheckService）。
 *
 * 在 AI 调用前逐条查询 Shopify 线上当前 Alt Text，判断候选是否仍然缺失。
 * 按 alt_plane 分类调用不同 GraphQL 查询：
 *   - FILE_ALT            → node(MediaImage) → image.altText
 *   - COLLECTION_IMAGE_ALT → node(Collection) → image.altText
 *   - ARTICLE_IMAGE_ALT   → node(Article)    → image.altText
 *
 * 错误分类:
 *   - Shopify 暂时不可用（5xx / 网络超时）→ 抛出 TruthCheckRetryableError（可重试）
 *   - 资源已被删除（node 返回 null）       → 返回 { isDeleted: true }
 */

import { AltPlane } from "@prisma/client";
import { decryptToken } from "../../crypto/token-encryption";
import prisma from "../../db/prisma.server";
import { getShopifyRateLimiter } from "../../shopify/shopify-rate-limiter.server";
import { createLogger } from "../../utils/logger";

const logger = createLogger({ module: "truth-check-service" });

const SHOPIFY_ADMIN_API_VERSION = "2026-04";

// ============================================================
// 公共类型
// ============================================================

export interface TruthCheckCandidate {
  /** 候选对应的 AltCandidate.id（仅用于日志） */
  candidateId: string;
  /** 店铺 ID（用于获取 Access Token）*/
  shopId: string;
  /** alt_plane 决定使用哪种 GraphQL 查询 */
  altPlane: AltPlane;
  /**
   * Shopify 全局资源 ID（GID），即 AltTarget.writeTargetId：
   *   - FILE_ALT            → gid://shopify/MediaImage/xxx
   *   - COLLECTION_IMAGE_ALT → gid://shopify/Collection/xxx
   *   - ARTICLE_IMAGE_ALT   → gid://shopify/Article/xxx
   */
  writeTargetId: string;
}

export interface TruthCheckResult {
  /** 当前 Alt Text 是否为空（缺失） */
  isEmpty: boolean;
  /** 当前 Alt Text，资源不存在或 Alt 为空时为 null */
  currentAlt: string | null;
  /** 资源已被从 Shopify 删除（node 返回 null）*/
  isDeleted?: boolean;
}

/** 可重试错误：Shopify 暂时不可用 */
export class TruthCheckRetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TruthCheckRetryableError";
  }
}

// ============================================================
// GraphQL 响应类型
// ============================================================

interface ShopifyNodeResponse<TNode> {
  data?: { node: TNode | null };
  errors?: Array<{ message: string }>;
}

interface MediaImageNode {
  __typename: "MediaImage";
  image: { altText: string | null } | null;
}

interface CollectionNode {
  __typename: "Collection";
  image: { altText: string | null } | null;
}

interface ArticleNode {
  __typename: "Article";
  image: { altText: string | null } | null;
}

// ============================================================
// 内部工具：获取店铺访问凭证
// ============================================================

interface ShopAdminContext {
  shopDomain: string;
  accessToken: string;
}

async function getShopAdminContext(shopId: string): Promise<ShopAdminContext> {
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

// ============================================================
// 内部工具：执行单条 Shopify Admin GraphQL 查询
// ============================================================

/**
 * 执行 Shopify Admin GraphQL 查询。
 * 5xx 响应 → 抛出 TruthCheckRetryableError
 * GraphQL errors 字段存在 → 抛出 TruthCheckRetryableError
 */
async function executeNodeQuery<TNode>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<TNode | null> {
  let response: Response;

  try {
    response = await fetch(
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
  } catch (err) {
    // 网络层错误（DNS 解析失败、连接超时等），标记为可重试
    throw new TruthCheckRetryableError(
      `Shopify Admin GraphQL network error: ${(err as Error).message}`,
      err,
    );
  }

  if (response.status >= 500) {
    throw new TruthCheckRetryableError(
      `Shopify Admin GraphQL server error: ${response.status} ${response.statusText}`,
    );
  }

  if (response.status === 429) {
    throw new TruthCheckRetryableError(
      `Shopify Admin GraphQL rate limited: 429 Too Many Requests`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Shopify Admin GraphQL client error: ${response.status} ${response.statusText}`,
    );
  }

  const payload = (await response.json()) as ShopifyNodeResponse<TNode>;

  if (payload.errors && payload.errors.length > 0) {
    throw new TruthCheckRetryableError(
      `Shopify Admin GraphQL returned errors: ${payload.errors.map((e) => e.message).join("; ")}`,
    );
  }

  return payload.data?.node ?? null;
}

// ============================================================
// 各 alt_plane 查询实现
// ============================================================

/** FILE_ALT: 查询 MediaImage 节点的 image.altText */
async function checkFileAlt(
  shopDomain: string,
  accessToken: string,
  mediaImageId: string,
): Promise<TruthCheckResult> {
  const query = `
    query TruthCheckMediaImage($id: ID!) {
      node(id: $id) {
        __typename
        ... on MediaImage {
          image {
            altText
          }
        }
      }
    }
  `;

  const node = await executeNodeQuery<MediaImageNode>(
    shopDomain,
    accessToken,
    query,
    { id: mediaImageId },
  );

  if (!node) {
    return { isEmpty: true, currentAlt: null, isDeleted: true };
  }

  const altText = node.image?.altText ?? null;
  const isEmpty = isAltEmpty(altText);
  return { isEmpty, currentAlt: altText };
}

/** COLLECTION_IMAGE_ALT: 查询 Collection 节点的 image.altText */
async function checkCollectionImageAlt(
  shopDomain: string,
  accessToken: string,
  collectionId: string,
): Promise<TruthCheckResult> {
  const query = `
    query TruthCheckCollection($id: ID!) {
      node(id: $id) {
        __typename
        ... on Collection {
          image {
            altText
          }
        }
      }
    }
  `;

  const node = await executeNodeQuery<CollectionNode>(
    shopDomain,
    accessToken,
    query,
    { id: collectionId },
  );

  if (!node) {
    return { isEmpty: true, currentAlt: null, isDeleted: true };
  }

  const altText = node.image?.altText ?? null;
  const isEmpty = isAltEmpty(altText);
  return { isEmpty, currentAlt: altText };
}

/** ARTICLE_IMAGE_ALT: 查询 Article 节点的 image.altText */
async function checkArticleImageAlt(
  shopDomain: string,
  accessToken: string,
  articleId: string,
): Promise<TruthCheckResult> {
  const query = `
    query TruthCheckArticle($id: ID!) {
      node(id: $id) {
        __typename
        ... on Article {
          image {
            altText
          }
        }
      }
    }
  `;

  const node = await executeNodeQuery<ArticleNode>(
    shopDomain,
    accessToken,
    query,
    { id: articleId },
  );

  if (!node) {
    return { isEmpty: true, currentAlt: null, isDeleted: true };
  }

  const altText = node.image?.altText ?? null;
  const isEmpty = isAltEmpty(altText);
  return { isEmpty, currentAlt: altText };
}

// ============================================================
// 辅助函数
// ============================================================

/** 判断 Alt Text 是否为空（null / 空字符串 / 纯空白） */
function isAltEmpty(alt: string | null | undefined): boolean {
  if (alt === null || alt === undefined) return true;
  return alt.trim().length === 0;
}

// ============================================================
// 主服务：TruthCheckService
// ============================================================

/**
 * TruthCheckService — 真值复核服务
 *
 * @example
 *   const result = await TruthCheckService.checkCurrentAlt({
 *     candidateId: "cand_xxx",
 *     shopId: "shop_xxx",
 *     altPlane: AltPlane.FILE_ALT,
 *     writeTargetId: "gid://shopify/MediaImage/123",
 *   });
 *   if (result.isDeleted) { // 资源已删除，跳过 }
 *   if (!result.isEmpty)   { // Alt 已存在，跳过 }
 */
export const TruthCheckService = {
  /**
   * 查询 Shopify 线上当前 Alt Text，判断候选是否仍然缺失。
   *
   * 使用进程内令牌桶限流器（与扫描管线共用），
   * 每次调用消耗 1 个令牌（Shopify GraphQL 单节点查询默认 cost=1）。
   *
   * @throws TruthCheckRetryableError — Shopify 暂时不可用，应由调用方重试
   * @throws Error — 无法识别的 altPlane（编程错误）或 Shop 未找到
   */
  async checkCurrentAlt(
    candidate: TruthCheckCandidate,
  ): Promise<TruthCheckResult> {
    const { candidateId, shopId, altPlane, writeTargetId } = candidate;

    // 1. 令牌桶限流
    const rateLimiter = getShopifyRateLimiter(shopId);
    await rateLimiter.acquire(1);

    // 2. 获取店铺鉴权信息
    const { shopDomain, accessToken } = await getShopAdminContext(shopId);

    logger.debug(
      { candidateId, shopId, altPlane, writeTargetId },
      "truth-check.checking",
    );

    // 3. 按 altPlane 分发查询
    let result: TruthCheckResult;

    switch (altPlane) {
      case AltPlane.FILE_ALT:
        result = await checkFileAlt(shopDomain, accessToken, writeTargetId);
        break;

      case AltPlane.COLLECTION_IMAGE_ALT:
        result = await checkCollectionImageAlt(
          shopDomain,
          accessToken,
          writeTargetId,
        );
        break;

      case AltPlane.ARTICLE_IMAGE_ALT:
        result = await checkArticleImageAlt(
          shopDomain,
          accessToken,
          writeTargetId,
        );
        break;

      default: {
        // TypeScript 穷举检查
        const exhaustive: never = altPlane;
        throw new Error(`Unsupported alt_plane: ${exhaustive}`);
      }
    }

    logger.info(
      {
        candidateId,
        shopId,
        altPlane,
        writeTargetId,
        isEmpty: result.isEmpty,
        isDeleted: result.isDeleted ?? false,
      },
      "truth-check.checked",
    );

    return result;
  },
};
