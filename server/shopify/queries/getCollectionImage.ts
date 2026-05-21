/**
 * File: server/shopify/queries/getCollectionImage.ts
 * Purpose: 读取单个 Shopify Collection 封面图（image.url / image.altText），
 *          无图返回 null。
 */

import type { Session } from "@shopify/shopify-api";
import { executeShopifyGraphql } from "../../modules/writeback/mutations/mutation-utils";
import type { ShopifyGraphqlResponse } from "../../modules/writeback/writeback.types";

const COLLECTION_IMAGE_QUERY = /* GraphQL */ `
  query GetCollectionImage($id: ID!) {
    collection(id: $id) {
      image {
        url
        altText
      }
    }
  }
`;

interface CollectionImageData {
  url: string;
  altText: string | null;
}

interface CollectionImageNode {
  image: CollectionImageData | null;
}

interface CollectionImageResponse {
  collection?: CollectionImageNode | null;
}

export interface CollectionImageResult {
  url: string;
  altText: string | null;
}

export async function getCollectionImage(params: {
  session: Session;
  shopifyGid: string;
}): Promise<CollectionImageResult | null> {
  const result: ShopifyGraphqlResponse<CollectionImageResponse> =
    await executeShopifyGraphql<CollectionImageResponse>({
      session: params.session,
      query: COLLECTION_IMAGE_QUERY,
      variables: { id: params.shopifyGid },
      cost: 1,
    });

  if (result.errors?.length) {
    throw new Error(
      `GraphQL errors: ${result.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const image = result.data?.collection?.image;
  if (!image?.url) return null;

  return { url: image.url, altText: image.altText };
}
