// ndjson-parsers.ts
import * as fs from "node:fs";
import * as readline from "node:readline";

/** Shared types */
export type ShopifyGid = string;

export interface ShopifyImage {
  url: string;
  altText: string | null;
}

/** Articles */
export interface BulkArticleRecord {
  id: ShopifyGid;
  title: string;
  image: ShopifyImage | null;
}

/** Collections */
export interface BulkCollectionRecord {
  id: ShopifyGid;
  title: string;
  image: ShopifyImage | null;
}

/** Files (MediaImage) */
export interface BulkFileRecord {
  id: ShopifyGid;
  image: ShopifyImage; // in sample it's always present
}

/** ---------- Generic NDJSON reader ---------- */

export async function parseNdjsonFile<T>(
  filePath: string,
  mapLine: (obj: unknown, ctx: { line: number; raw: string }) => T
): Promise<T[]> {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const out: T[] = [];
  let lineNo = 0;

  try {
    for await (const raw of rl) {
      lineNo++;
      const line = raw.trim();
      if (!line) continue;

      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch (e) {
        throw new Error(
          `Invalid JSON at ${filePath}:${lineNo}\n${line}\n${String(e)}`
        );
      }

      out.push(mapLine(obj, { line: lineNo, raw: line }));
    }
  } finally {
    rl.close();
    input.close();
  }

  return out;
}

/** ---------- Minimal runtime validators (type guards) ---------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function parseImage(v: unknown, ctx: string): ShopifyImage | null {
  if (v === null) return null;
  if (!isObject(v)) throw new Error(`${ctx}.image must be object|null`);

  const url = v.url;
  const altText = v.altText;

  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`${ctx}.image.url must be a non-empty string`);
  }
  if (!(typeof altText === "string" || altText === null || altText === undefined)) {
    throw new Error(`${ctx}.image.altText must be string|null`);
  }

  return { url, altText: altText ?? null };
}

/** ---------- Specific parsers for your fixtures ---------- */

export function parseBulkArticles(filePath: string) {
  return parseNdjsonFile<BulkArticleRecord>(filePath, (obj, { line }) => {
    const ctx = `Article line ${line}`;
    if (!isObject(obj)) throw new Error(`${ctx} must be an object`);

    const id = obj.id;
    const title = obj.title;

    if (typeof id !== "string") throw new Error(`${ctx}.id must be string`);
    if (typeof title !== "string") throw new Error(`${ctx}.title must be string`);

    const image = parseImage(obj.image, ctx);

    return { id, title, image };
  });
}

export function parseBulkCollections(filePath: string) {
  return parseNdjsonFile<BulkCollectionRecord>(filePath, (obj, { line }) => {
    const ctx = `Collection line ${line}`;
    if (!isObject(obj)) throw new Error(`${ctx} must be an object`);

    const id = obj.id;
    const title = obj.title;

    if (typeof id !== "string") throw new Error(`${ctx}.id must be string`);
    if (typeof title !== "string") throw new Error(`${ctx}.title must be string`);

    const image = parseImage(obj.image, ctx);

    return { id, title, image };
  });
}

export function parseBulkFiles(filePath: string) {
  return parseNdjsonFile<BulkFileRecord>(filePath, (obj, { line }) => {
    const ctx = `File line ${line}`;
    if (!isObject(obj)) throw new Error(`${ctx} must be an object`);

    const id = obj.id;
    if (typeof id !== "string") throw new Error(`${ctx}.id must be string`);

    const image = parseImage(obj.image, ctx);
    if (!image) throw new Error(`${ctx}.image must not be null`);

    return { id, image };
  });
}

/** ---------- Example usage ---------- */
// (async () => {
//   const articles = await parseBulkArticles("fixtures/bulk_articles.ndjson");
//   const collections = await parseBulkCollections("fixtures/bulk_collections.ndjson");
//   const files = await parseBulkFiles("fixtures/bulk_files.ndjson");
//
//   console.log({ articles: articles.length, collections: collections.length, files: files.length });
// })();