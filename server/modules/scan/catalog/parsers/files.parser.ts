/**
 * File: server/modules/scan/catalog/parsers/files.parser.ts
 * Purpose: Files（店铺文件库 MediaImage）资源类型的行处理器（row handler）。
 *
 * NDJSON 行结构（扁平，无 __parentId）:
 *   {"id":"gid://shopify/MediaImage/<id>","image":{"url":"...","altText":"..."}}
 */
import type { RowContext } from "./ndjson-stream-parser";
import type { StgMediaImageFileRow } from "./staging.types";
import { isObject, isShopifyGid, parseShopifyImage } from "./staging.types";

/**
 * 创建 Files 行处理器。
 * 每行解析为一个 StgMediaImageFileRow，用于批量写入 stg_media_image_file 表。
 */
export function createFilesRowHandler() {
  return function handleFilesRow(
    obj: unknown,
    ctx: RowContext,
  ): StgMediaImageFileRow {
    const label = `File line ${ctx.lineNo}`;

    if (!isObject(obj)) throw new Error(`${label}: must be an object`);

    const id = obj.id;
    if (!isShopifyGid(id)) {
      throw new Error(`${label}.id must be a valid Shopify GID, got: ${String(id)}`);
    }

    // Files 的 image 字段是必填的（文件库中的 MediaImage 必有 image）
    const image = parseShopifyImage(obj.image, label);
    if (!image) {
      throw new Error(`${label}.image must not be null for Files`);
    }

    return {
      mediaImageId: id,
      alt: image.altText,
      url: image.url,
    };
  };
}
