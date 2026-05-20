/**
 * File: server/modules/writeback/writeback-router.ts
 * Purpose: 按 alt_plane 路由到对应 Shopify 写回 mutation executor。
 */

import { AltPlane } from "@prisma/client";
import type { MutationExecutor, ShopifyGraphqlExecutor } from "./writeback.types";
import { ArticleAltExecutor } from "./mutations/article-update.mutation";
import { CollectionAltExecutor } from "./mutations/collection-update.mutation";
import { FileAltExecutor } from "./mutations/file-update.mutation";

export class WritebackRouter {
  private readonly registry: Record<AltPlane, MutationExecutor>;

  constructor(graphql?: ShopifyGraphqlExecutor) {
    this.registry = {
      [AltPlane.FILE_ALT]: new FileAltExecutor(graphql),
      [AltPlane.COLLECTION_IMAGE_ALT]: new CollectionAltExecutor(graphql),
      [AltPlane.ARTICLE_IMAGE_ALT]: new ArticleAltExecutor(graphql),
    };
  }

  getExecutor(altPlane: AltPlane): MutationExecutor {
    return this.registry[altPlane];
  }
}
