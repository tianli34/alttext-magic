/**
 * File: server/modules/writeback/mutations/article-update.mutation.ts
 * Purpose: ARTICLE_IMAGE_ALT 平面的 Shopify articleUpdate 写回执行器。
 */

import type { Session } from "@shopify/shopify-api";
import type {
  MutationExecutor,
  ShopifyGraphqlExecutor,
  ShopifyUserError,
  WritebackResult,
} from "../writeback.types";
import { executeShopifyGraphql, formatUserErrors, isRetryableUserError } from "./mutation-utils";

const ARTICLE_UPDATE_MUTATION = /* GraphQL */ `
  mutation WritebackArticleImageAlt($id: ID!, $article: ArticleUpdateInput!) {
    articleUpdate(id: $id, article: $article) {
      article {
        id
        image {
          altText
        }
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

interface ArticleUpdatePayload {
  articleUpdate?: {
    article: {
      id: string;
      image: { altText: string | null } | null;
    } | null;
    userErrors: ShopifyUserError[];
  } | null;
}

export class ArticleAltExecutor implements MutationExecutor {
  constructor(
    private readonly graphql: ShopifyGraphqlExecutor = executeShopifyGraphql,
  ) {}

  async execute(params: {
    session: Session;
    shopifyGid: string;
    altText: string;
  }): Promise<WritebackResult> {
    try {
      const payload = await this.graphql<ArticleUpdatePayload>({
        session: params.session,
        query: ARTICLE_UPDATE_MUTATION,
        variables: {
          id: params.shopifyGid,
          article: {
            image: { altText: params.altText },
          },
        },
        cost: 10,
      });

      if (payload.errors?.length) {
        return {
          success: false,
          error: payload.errors.map((error) => error.message).join("; "),
          retryable: true,
        };
      }

      const userErrors = payload.data?.articleUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return {
          success: false,
          error: formatUserErrors(userErrors),
          retryable: userErrors.some(isRetryableUserError),
        };
      }

      if (!payload.data?.articleUpdate) {
        return {
          success: false,
          error: "Shopify articleUpdate returned an empty payload",
          retryable: true,
        };
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }
}

export const _ARTICLE_UPDATE_MUTATION_FOR_TESTS = ARTICLE_UPDATE_MUTATION;
