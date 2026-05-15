import { ParentIdCache } from "./ndjson-stream-parser";
import { isObject, parseShopifyImage } from "./staging.types";
/** Product 行：有 id 且包含 /Product/，无 __parentId */
function isProductRow(row) {
    return (typeof row.id === "string" &&
        row.id.includes("/Product/") &&
        typeof row.title === "string" &&
        !("__parentId" in row));
}
/** MediaImage 行：有 id 且包含 /MediaImage/，有 __parentId */
function isMediaImageRow(row) {
    return (typeof row.id === "string" &&
        row.id.includes("/MediaImage/") &&
        typeof row.__parentId === "string");
}
/* ------------------------------------------------------------------ */
/*  createProductMediaRowHandler                                       */
/* ------------------------------------------------------------------ */
/**
 * 创建 Product-Media 行处理器。
 *
 * 内部维护:
 * - productCache: 缓存 Product 基本信息（title, handle），供 MediaImage 行查找
 * - positionCounters: 每个 productId 的 position_index 计数器
 *
 * 返回值为 ProductMediaFlushItem 联合类型，
 * onFlush 回调需按 kind 字段分发到 stg_product / stg_media_image_product 表。
 */
export function createProductMediaRowHandler() {
    /** 缓存 Product 行的基本信息 */
    const productCache = new ParentIdCache();
    /** 每个 productId 的 position_index 自动计数器（0-based），仅在 Shopify 未返回 position 时使用 */
    const positionCounters = new Map();
    /** 获取下一个自动递增的 position（0-based） */
    function nextAutoPosition(productId) {
        const curr = positionCounters.get(productId) ?? -1;
        const next = curr + 1;
        positionCounters.set(productId, next);
        return next;
    }
    /** @returns 产品缓存（供外部检查/排障） */
    function getProductCache() {
        return productCache;
    }
    /** 行处理函数 */
    function handleProductMediaRow(obj, ctx) {
        if (!isObject(obj)) {
            throw new Error(`Product-Media line ${ctx.lineNo}: must be an object`);
        }
        // ── Product 父行 ──
        if (isProductRow(obj)) {
            const productId = obj.id;
            const title = obj.title;
            const handle = typeof obj.handle === "string" ? obj.handle : "";
            productCache.set(productId, { title, handle });
            const productRow = { productId, title, handle };
            return { kind: "product", data: productRow };
        }
        // ── MediaImage 子行 ──
        if (isMediaImageRow(obj)) {
            const mediaImageId = obj.id;
            const parentProductId = obj.__parentId;
            const image = parseShopifyImage(obj.image, `MediaImage line ${ctx.lineNo}`);
            // position_index 优先使用 Shopify 返回的 position 字段（Int 类型）
            // 若无则按同一 product 下出现顺序自动递增（0-based）
            const shopifyPosition = obj.position;
            const positionIndex = typeof shopifyPosition === "number" && Number.isFinite(shopifyPosition)
                ? shopifyPosition
                : nextAutoPosition(parentProductId);
            // image 为 null 时仍产出记录（标记缺失的图片数据）
            const mediaRow = {
                mediaImageId,
                parentProductId,
                alt: image?.altText ?? null,
                url: image?.url ?? "",
                positionIndex,
            };
            return { kind: "media", data: mediaRow };
        }
        // ── 其他行（Video、仅 __parentId 的空行等）→ 跳过 ──
        return undefined;
    }
    return {
        handleRow: handleProductMediaRow,
        getProductCache,
        /** 清除内部缓存，释放内存（流处理结束后调用） */
        dispose() {
            productCache.clear();
            positionCounters.clear();
        },
    };
}
