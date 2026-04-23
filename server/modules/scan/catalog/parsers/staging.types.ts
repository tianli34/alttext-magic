/**
 * File: server/modules/scan/catalog/parsers/staging.types.ts
 * Purpose: 流式解析器产出的 staging 行类型定义。
 *
 * 这些类型对应各 Stg* 表的字段（不含 id / shopId / scanTaskAttemptId 等运行时注入字段）。
 * parser callback 返回这些结构，由 staging.service.ts 在 flush 时补充运行时字段。
 */

/* ------------------------------------------------------------------ */
/*  共享校验工具                                                        */
/* ------------------------------------------------------------------ */

/** Shopify GID 格式校验 */
export function isShopifyGid(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("gid://shopify/");
}

/** 判断值是否为纯对象（非 null、非数组） */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 解析 Shopify image 对象 */
export interface ShopifyImageResult {
  url: string;
  altText: string | null;
}

export function parseShopifyImage(
  v: unknown,
  ctx: string,
): ShopifyImageResult | null {
  if (v === null || v === undefined) return null;
  if (!isObject(v)) throw new Error(`${ctx}.image must be object|null`);

  const url = v.url;
  const altText = v.altText;

  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${ctx}.image.url must be a non-empty string`);
  }
  if (
    !(
      typeof altText === "string" ||
      altText === null ||
      altText === undefined
    )
  ) {
    throw new Error(`${ctx}.image.altText must be string|null`);
  }

  return { url, altText: altText ?? null };
}

/* ------------------------------------------------------------------ */
/*  Article staging 行                                                  */
/* ------------------------------------------------------------------ */

export interface StgArticleRow {
  articleId: string;
  title: string;
  handle: string;
  imageAltText: string | null;
  imageUrl: string | null;
}

/* ------------------------------------------------------------------ */
/*  Collection staging 行                                               */
/* ------------------------------------------------------------------ */

export interface StgCollectionRow {
  collectionId: string;
  title: string;
  handle: string;
  imageAltText: string | null;
  imageUrl: string | null;
}

/* ------------------------------------------------------------------ */
/*  Files staging 行                                                    */
/* ------------------------------------------------------------------ */

export interface StgMediaImageFileRow {
  mediaImageId: string;
  alt: string | null;
  url: string;
}

/* ------------------------------------------------------------------ */
/*  Product-Media staging 行（需 __parentId 映射）                       */
/* ------------------------------------------------------------------ */

export interface StgProductRow {
  productId: string;
  title: string;
  handle: string;
}

export interface StgMediaImageProductRow {
  mediaImageId: string;
  parentProductId: string;
  alt: string | null;
  url: string;
  positionIndex: number;
}

/** Product-Media flush 条目：带类型标签的联合类型 */
export type ProductMediaFlushItem =
  | { kind: "product"; data: StgProductRow }
  | { kind: "media"; data: StgMediaImageProductRow };
