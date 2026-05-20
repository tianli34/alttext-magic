/**
 * File: server/modules/writeback/mutations/file-update.mutation.ts
 * Purpose: FILE_ALT 平面的 Shopify fileUpdate 写回执行器。
 */

import type {
  MutationExecutor,
  ShopifyGraphqlExecutor,
  ShopifyUserError,
  WritebackResult,
} from "../writeback.types";
import type { Session } from "@shopify/shopify-api";
import { executeShopifyGraphql, formatUserErrors, isRetryableUserError } from "./mutation-utils";

const FILE_UPDATE_MUTATION = /* GraphQL */ `
  mutation WritebackFileAlt($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        alt
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

interface FileUpdatePayload {
  fileUpdate?: {
    files: Array<{
      id: string;
      alt: string | null;
      fileStatus?: string | null;
    }> | null;
    userErrors: ShopifyUserError[];
  } | null;
}

export class FileAltExecutor implements MutationExecutor {
  constructor(
    private readonly graphql: ShopifyGraphqlExecutor = executeShopifyGraphql,
  ) {}

  async execute(params: {
    session: Session;
    shopifyGid: string;
    altText: string;
  }): Promise<WritebackResult> {
    try {
      const payload = await this.graphql<FileUpdatePayload>({
        session: params.session,
        query: FILE_UPDATE_MUTATION,
        variables: {
          files: [{ id: params.shopifyGid, alt: params.altText }],
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

      const userErrors = payload.data?.fileUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        return {
          success: false,
          error: formatUserErrors(userErrors),
          retryable: userErrors.some(isRetryableUserError),
        };
      }

      if (!payload.data?.fileUpdate) {
        return {
          success: false,
          error: "Shopify fileUpdate returned an empty payload",
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

export const _FILE_UPDATE_MUTATION_FOR_TESTS = FILE_UPDATE_MUTATION;
