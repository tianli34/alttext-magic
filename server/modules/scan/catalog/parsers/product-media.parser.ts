/**
 * File: server/modules/scan/catalog/parsers/product-media.parser.ts
 * Purpose: Product-Media 资源类型的行处理器，支持 __parentId 父子行映射。
 *
 * NDJSON 行结构（父子行交错）:
 *
 *   父行（Product，无 __parentId）:
 *     {"id":"gid://shopify/Product/123","title":"xxx"}
 *
 *   子行（MediaImage，有 __parentId）:
 *     {"id":"gid://shopify/MediaImage/456",
 *      "image":{"url":"...","altText":"..."},
 *      "__parentId":"gid://shopify/Product/123"}
 *
 * 特殊行（Video 等非 MediaImage 的子行，仅有 __parentId，无 id/image）:
 *     {"__parentId":"gid://shopify/Product/xxx"}
 *
 * 处理策略:
 * - Product 行 → 缓存到 ParentIdCache，同时产出 { kind: 'product' } flush 条目
 * - MediaImage 行 → 通过 __parentId 查找父 Product，产出 { kind: 'media' } flush 条目
 * - 其他行（Video 等）→ 跳过
 * - position_index 按同一 Product 下的 media 出现顺序递增（1-based）
 */
import type { RowContext } from "./ndjson-stream-parser";
import { ParentIdCache } from "./ndjson-stream-parser";
import type {
  ProductMediaFlushItem,
  StgProductRow,
  StgMediaImageProductRow,
} from "./staging.types";
import { isObject, isShopifyGid, parseShopifyImage } from "./staging.types";

/* ------------------------------------------------------------------ */
/*  行类型判断                                                          */
/* ------------------------------------------------------------------ */

type RawRow = Record<string, unknown>;

/** Product 行：有 id 且包含 /Product/，无 __parentId */
function isProductRow(row: RawRow): boolean {
  return (
    typeof row.id === "string" &&
    row.id.includes("/Product/") &&
    typeof row.title === "string" &&
    !("__parentId" in row)
  );
}

/** MediaImage 行：有 id 且包含 /MediaImage/，有 __parentId */
function isMediaImageRow(row: RawRow): boolean {
  return (
    typeof row.id === "string" &&
    row.id.includes("/MediaImage/") &&
    typeof row.__parentId === "string"
  );
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
  const productCache = new ParentIdCache<{ title: string; handle: string }>();

  /** 每个 productId 的 position_index 计数器（1-based） */
  const positionCounters = new Map<string, number>();

  function nextPosition(productId: string): number {
    const curr = positionCounters.get(productId) ?? 0;
    const next = curr + 1;
    positionCounters.set(productId, next);
    return next;
  }

  /** @returns 产品缓存（供外部检查/排障） */
  function getProductCache() {
    return productCache;
  }

  /** 行处理函数 */
  function handleProductMediaRow(
    obj: unknown,
    ctx: RowContext,
  ): ProductMediaFlushItem | undefined {
    if (!isObject(obj)) {
      throw new Error(`Product-Media line ${ctx.lineNo}: must be an object`);
    }

    // ── Product 父行 ──
    if (isProductRow(obj)) {
      const productId = obj.id as string;
      const title = obj.title as string;
      const handle =
        typeof obj.handle === "string" ? obj.handle : "";

      productCache.set(productId, { title, handle });

      const productRow: StgProductRow = { productId, title, handle };
      return { kind: "product", data: productRow };
    }

    // ── MediaImage 子行 ──
    if (isMediaImageRow(obj)) {
      const mediaImageId = obj.id as string;
      const parentProductId = obj.__parentId as string;

      const image = parseShopifyImage(
        obj.image,
        `MediaImage line ${ctx.lineNo}`,
      );

      // image 为 null 时仍产出记录（标记缺失的图片数据）
      const mediaRow: StgMediaImageProductRow = {
        mediaImageId,
        parentProductId,
        alt: image?.altText ?? null,
        url: image?.url ?? "",
        positionIndex: nextPosition(parentProductId),
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
