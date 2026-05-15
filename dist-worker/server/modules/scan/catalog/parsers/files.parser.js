import { isObject, isShopifyGid, parseShopifyImage } from "./staging.types";
/**
 * 创建 Files 行处理器。
 * 每行解析为一个 StgMediaImageFileRow，用于批量写入 stg_media_image_file 表。
 */
export function createFilesRowHandler() {
    return function handleFilesRow(obj, ctx) {
        const label = `File line ${ctx.lineNo}`;
        if (!isObject(obj))
            throw new Error(`${label}: must be an object`);
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
