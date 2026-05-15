import { isObject, isShopifyGid, parseShopifyImage } from "./staging.types";
/**
 * 创建 Collection 行处理器。
 * 每行解析为一个 StgCollectionRow，用于批量写入 stg_collection 表。
 */
export function createCollectionRowHandler() {
    return function handleCollectionRow(obj, ctx) {
        const label = `Collection line ${ctx.lineNo}`;
        if (!isObject(obj))
            throw new Error(`${label}: must be an object`);
        const id = obj.id;
        if (!isShopifyGid(id)) {
            throw new Error(`${label}.id must be a valid Shopify GID, got: ${String(id)}`);
        }
        const title = obj.title;
        if (typeof title !== "string") {
            throw new Error(`${label}.title must be a string`);
        }
        const handle = typeof obj.handle === "string" ? obj.handle : "";
        const image = parseShopifyImage(obj.image, label);
        return {
            collectionId: id,
            title,
            handle,
            imageAltText: image?.altText ?? null,
            imageUrl: image?.url ?? null,
        };
    };
}
