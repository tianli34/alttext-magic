/**
 * File: server/modules/writeback/mutations/collection-update.mutation.ts
 * Purpose: COLLECTION_IMAGE_ALT 平面的 Shopify collectionUpdate 写回执行器。
 */
import { executeShopifyGraphql, formatUserErrors, isRetryableUserError, toExecutorFailure, toGraphqlErrorsFailure, } from "./mutation-utils";
const COLLECTION_UPDATE_MUTATION = /* GraphQL */ `
  mutation WritebackCollectionImageAlt($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        image {
          altText
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;
export class CollectionAltExecutor {
    graphql;
    constructor(graphql = executeShopifyGraphql) {
        this.graphql = graphql;
    }
    async execute(params) {
        try {
            const payload = await this.graphql({
                session: params.session,
                query: COLLECTION_UPDATE_MUTATION,
                variables: {
                    input: {
                        id: params.shopifyGid,
                        image: { altText: params.altText },
                    },
                },
                cost: 10,
            });
            if (payload.errors?.length) {
                return toGraphqlErrorsFailure(payload.errors);
            }
            const userErrors = payload.data?.collectionUpdate?.userErrors ?? [];
            if (userErrors.length > 0) {
                return {
                    success: false,
                    error: formatUserErrors(userErrors),
                    retryable: userErrors.some(isRetryableUserError),
                };
            }
            if (!payload.data?.collectionUpdate) {
                return {
                    success: false,
                    error: "Shopify collectionUpdate returned an empty payload",
                    retryable: true,
                };
            }
            return { success: true };
        }
        catch (err) {
            return toExecutorFailure(err);
        }
    }
}
export const _COLLECTION_UPDATE_MUTATION_FOR_TESTS = COLLECTION_UPDATE_MUTATION;
