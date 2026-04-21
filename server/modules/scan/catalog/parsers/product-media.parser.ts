/**
 * app/lib/bulk/parsers/parseProductMedia.ts
 *
 * 解析 bulk_product_media.ndjson
 * 按同一 product 下 media 出现顺序生成稳定的 position_index（1-based）
 *
 * 实际 NDJSON 行结构（无 __typename 字段）：
 *
 *   Product 行（无 __parentId）：
 *     {"id":"gid://shopify/Product/123","title":"xxx"}
 *
 *   MediaImage 行（有 __parentId）：
 *     {"id":"gid://shopify/MediaImage/456",
 *      "image":{"url":"...","altText":"..."},
 *      "__parentId":"gid://shopify/Product/123"}
 */

import * as fs from "fs";
import * as readline from "readline";

// ─── 输入行类型 ────────────────────────────────────────────────────────────────

interface RawProductRow {
  id: string;          // "gid://shopify/Product/..."
  title: string;
  handle?: string;     // query 里有，但 bulk 实际可能不返回
  __parentId?: never;  // Product 行无此字段
}

interface RawMediaImageRow {
  id: string;          // "gid://shopify/MediaImage/..."
  __parentId: string;  // "gid://shopify/Product/..."
  image: {
    url: string;
    altText: string | null;
  } | null;
}

type RawRow = Record<string, unknown>;

// ─── 输出类型 ──────────────────────────────────────────────────────────────────

export interface ParsedMediaImage {
  id: string;
  alt: string | null;
  image: {
    url: string;
  } | null;
  /** 在该 product 下的展示顺序，1-based，由出现顺序推导 */
  position_index: number;
}

export interface ParsedProduct {
  id: string;
  title: string;
  handle: string | null;
  media: ParsedMediaImage[];
}

// ─── 类型守卫 ──────────────────────────────────────────────────────────────────

/** Product 行：有 id、title，无 __parentId */
function isProductRow(row: RawRow): row is RawProductRow & RawRow {
  return (
    typeof row.id === "string" &&
    row.id.includes("/Product/") &&
    typeof row.title === "string" &&
    !("__parentId" in row)
  );
}

/** MediaImage 行：有 id、__parentId，id 含 /MediaImage/ */
function isMediaImageRow(row: RawRow): row is RawMediaImageRow & RawRow {
  return (
    typeof row.id === "string" &&
    row.id.includes("/MediaImage/") &&
    typeof row.__parentId === "string"
  );
}

// ─── 核心解析函数 ──────────────────────────────────────────────────────────────

export async function parseProductMediaNdjson(
  filePath: string
): Promise<ParsedProduct[]> {
  // insertion-order（ES2015+ 规范保证 Map 遍历顺序为插入顺序）
  const productMap = new Map<string, Omit<ParsedProduct, "media">>();

  // 每个 productId 对应的 media 列表（已带 position_index）
  const mediaByProduct = new Map<string, ParsedMediaImage[]>();

  // 每个 productId 一个计数器：用于生成 position_index
  const positionByProductId = new Map<string, number>();
  const nextPosition = (productId: string) => {
    const curr = positionByProductId.get(productId) ?? 0;
    const next = curr + 1;
    positionByProductId.set(productId, next);
    return next;
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let row: RawRow;
    try {
      row = JSON.parse(trimmed) as RawRow;
    } catch {
      console.warn(
        `[parseProductMedia] 跳过无效 JSON 行: ${trimmed.slice(0, 80)}`
      );
      continue;
    }

    if (isProductRow(row)) {
      productMap.set(row.id, {
        id: row.id,
        title: row.title,
        handle: typeof row.handle === "string" ? row.handle : null,
      });

      // 初始化，保证无 media 的 product 也出现在结果里
      if (!mediaByProduct.has(row.id)) mediaByProduct.set(row.id, []);
      continue;
    }

    if (isMediaImageRow(row)) {
      const productId = row.__parentId;

      // 初始化该 product 的 media 列表（即使 product 行稍后才出现也没关系）
      if (!mediaByProduct.has(productId)) mediaByProduct.set(productId, []);

      const position_index = nextPosition(productId);

      const parsed: ParsedMediaImage = {
        id: row.id,
        alt: row.image?.altText ?? null,
        image: row.image ? { url: row.image.url } : null,
        position_index,
      };

      mediaByProduct.get(productId)!.push(parsed);
      continue;
    }

    // 其他类型（Video、ExternalVideo 等）暂不处理
  }

  // ── 组装结果：按 productMap 插入顺序输出 ───────────────────────────────────
  const result: ParsedProduct[] = [];
  for (const [productId, productBase] of productMap) {
    const media = mediaByProduct.get(productId) ?? [];
    result.push({ ...productBase, media });
  }

  return result;
}