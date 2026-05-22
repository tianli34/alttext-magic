/**
 * File: server/shopify/queries/getProductMedia.ts
 * Purpose: 读取单个 Shopify Product 的全部 MediaImage（id / alt / image.url），
 *          支持游标分页，空 media 返回 []。
 */

import type { Session } from "@shopify/shopify-api";
import { executeShopifyGraphql } from "../../modules/writeback/mutations/mutation-utils";
import type { ShopifyGraphqlResponse } from "../../modules/writeback/writeback.types";

const PRODUCT_MEDIA_QUERY = /* GraphQL */ `
  query GetProductMedia($productId: ID!, $first: Int!, $after: String) {
    product(id: $productId) {
      media(first: $first, after: $after) {
        nodes {
          ... on MediaImage {
            id
            alt
            image {
              url
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

interface MediaImageNode {
  id: string;
  alt: string | null;
  image: { url: string } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ProductMediaResponse {
  product?: {
    media?: {
      nodes: MediaImageNode[];
      pageInfo: PageInfo;
    } | null;
  } | null;
}

export interface ProductMediaItem {
  id: string;
  alt: string | null;
  url: string;
}

export async function getProductMedia(params: {
  session: Session;
  shopifyGid: string;
}): Promise<ProductMediaItem[]> {
  const allNodes: MediaImageNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const result: ShopifyGraphqlResponse<ProductMediaResponse> =
      await executeShopifyGraphql<ProductMediaResponse>({
        session: params.session,
        query: PRODUCT_MEDIA_QUERY,
        variables: {
          productId: params.shopifyGid,
          first: 250,
          after: cursor,
        },
        cost: 10,
      });

    if (result.errors?.length) {
      throw new Error(
        `GraphQL errors: ${result.errors.map((e: { message: string }) => e.message).join("; ")}`,
      );
    }

    const media:
      | { nodes: MediaImageNode[]; pageInfo: PageInfo }
      | null
      | undefined = result.data?.product?.media;
    const nodes = media?.nodes ?? [];
    allNodes.push(...nodes);

    hasNextPage = media?.pageInfo?.hasNextPage ?? false;
    cursor = media?.pageInfo?.endCursor ?? null;
  }

  return allNodes
    .filter((node) => node.image?.url)
    .map((node) => ({
      id: node.id,
      alt: node.alt,
      url: node.image!.url,
    }));
}
