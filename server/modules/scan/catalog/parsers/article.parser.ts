/**
 * File: server/modules/scan/catalog/parsers/article.parser.ts
 * Purpose: Article 资源类型的行处理器（row handler）。
 *
 * NDJSON 行结构:
 *   {"id":"gid://shopify/Article/<id>","title":"xxx","image":{"url":"...","altText":"..."} | null}
 */
import type { RowContext } from "./ndjson-stream-parser";
import type { StgArticleRow } from "./staging.types";
import { isObject, isShopifyGid, parseShopifyImage } from "./staging.types";

/**
 * 创建 Article 行处理器。
 * 每行解析为一个 StgArticleRow，用于批量写入 stg_article 表。
 */
export function createArticleRowHandler() {
  return function handleArticleRow(
    obj: unknown,
    ctx: RowContext,
  ): StgArticleRow {
    const label = `Article line ${ctx.lineNo}`;

    if (!isObject(obj)) throw new Error(`${label}: must be an object`);

    // id 校验
    const id = obj.id;
    if (!isShopifyGid(id)) {
      throw new Error(`${label}.id must be a valid Shopify GID, got: ${String(id)}`);
    }

    // title 校验
    const title = obj.title;
    if (typeof title !== "string") {
      throw new Error(`${label}.title must be a string`);
    }

    // handle（可选，Shopify bulk 查询可能不返回此字段）
    const handle =
      typeof obj.handle === "string" ? obj.handle : "";

    // image 解析
    const image = parseShopifyImage(obj.image, label);

    return {
      articleId: id,
      title,
      handle,
      imageAltText: image?.altText ?? null,
      imageUrl: image?.url ?? null,
    };
  };
}
