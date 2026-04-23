/**
 * File: server/modules/scan/catalog/parsers/ndjson-stream-parser.ts
 * Purpose: 通用流式 NDJSON 解析器 + 批量 flush 基础设施
 *
 * 核心能力:
 * - 从 URL (fetch) 或本地文件流式读取 NDJSON
 * - 逐行解析，禁止整文件读入内存
 * - 每 N 行（默认 500）自动 flush
 * - 支持 parser callback 模式：不同资源类型传入不同 row handler
 * - 提供 ParentIdCache 用于 __parentId 父子关系映射
 *
 * 使用方式:
 *   // 从 URL 流式解析
 *   await streamNdjsonFromUrl(bulkResultUrl, {
 *     handleRow: (obj, ctx) => parseArticleRow(obj, ctx),
 *     onFlush: async (batch) => { await db.stgArticle.createMany({ data: batch }); },
 *   });
 *
 *   // 从本地 fixture 文件回放
 *   await streamNdjsonFromFile('fixtures/bulk_articles.ndjson', { ... });
 */
import * as fs from "node:fs";
import * as readline from "node:readline";
import { Readable } from "node:stream";
import { createLogger } from "../../../../utils/logger";

const logger = createLogger({ module: "ndjson-stream-parser" });

/* ------------------------------------------------------------------ */
/*  类型定义                                                            */
/* ------------------------------------------------------------------ */

/** 逐行处理上下文 */
export interface RowContext {
  /** 当前行号（1-based） */
  lineNo: number;
  /** 原始行文本 */
  raw: string;
}

/** 流式解析结果统计 */
export interface StreamParseResult {
  /** 总行数（含空行和无效行） */
  totalLines: number;
  /** 跳过的行数（空行 + 无效 JSON + handler 主动跳过） */
  skippedLines: number;
  /** 已执行的 flush 批次数 */
  flushedBatches: number;
  /** flush 的总行数（所有批次累加） */
  flushedRows: number;
}

/** 流式解析选项 */
export interface StreamParserOptions<T> {
  /** 批量大小，默认 500 */
  batchSize?: number;
  /**
   * 逐行处理回调。
   * - 返回非 undefined 值 → 累积到当前批次
   * - 返回 undefined → 跳过该行（不累积）
   */
  handleRow: (parsed: unknown, ctx: RowContext) => T | undefined;
  /** 批量 flush 回调，当累积行数达到 batchSize 或流结束时触发 */
  onFlush: (batch: T[]) => Promise<void>;
  /** 进度回调（可选），每隔 progressInterval 行触发 */
  onProgress?: (stats: { totalLines: number; flushedBatches: number }) => void;
  /** 进度回调间隔（行数），默认 1000 */
  progressInterval?: number;
}

/* ------------------------------------------------------------------ */
/*  ParentIdCache：通用 __parentId 缓存映射                              */
/* ------------------------------------------------------------------ */

/**
 * 用于 Shopify Bulk Operation 中父子行关系的缓存映射。
 *
 * 典型场景：Product-Media 解析中，
 * - Product 行无 __parentId，需缓存为父记录
 * - MediaImage 行有 __parentId，通过缓存查找父 Product 信息
 *
 * 使用示例:
 *   const productCache = new ParentIdCache<{ title: string }>();
 *   // 遇到 Product 行
 *   productCache.set(productGid, { title: "..." });
 *   // 遇到 MediaImage 行
 *   const parent = productCache.get(row.__parentId);
 */
export class ParentIdCache<TValue> {
  private readonly cache = new Map<string, TValue>();

  /** 写入缓存 */
  set(id: string, value: TValue): void {
    this.cache.set(id, value);
  }

  /** 读取缓存，不存在返回 undefined */
  get(id: string): TValue | undefined {
    return this.cache.get(id);
  }

  /** 判断是否存在 */
  has(id: string): boolean {
    return this.cache.has(id);
  }

  /** 当前缓存条目数 */
  get size(): number {
    return this.cache.size;
  }

  /** 获取所有条目（用于流结束后残余处理） */
  entries(): IterableIterator<[string, TValue]> {
    return this.cache.entries();
  }

  /** 清除缓存，释放内存 */
  clear(): void {
    this.cache.clear();
  }
}

/* ------------------------------------------------------------------ */
/*  核心流式解析引擎                                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_PROGRESS_INTERVAL = 1000;

/**
 * 从 Node.js Readable 流中流式解析 NDJSON。
 * 逐行读取、逐行解析、按批次 flush，不会将整个文件加载到内存。
 */
async function parseFromStream<T>(
  stream: NodeJS.ReadableStream,
  options: StreamParserOptions<T>,
): Promise<StreamParseResult> {
  const {
    batchSize = DEFAULT_BATCH_SIZE,
    handleRow,
    onFlush,
    onProgress,
    progressInterval = DEFAULT_PROGRESS_INTERVAL,
  } = options;

  const rl = readline.createInterface({
    input: stream as Readable,
    crlfDelay: Infinity,
  });

  let totalLines = 0;
  let skippedLines = 0;
  let flushedBatches = 0;
  let flushedRows = 0;
  const batch: T[] = [];

  try {
    for await (const raw of rl) {
      totalLines++;
      const line = raw.trim();

      // 跳过空行
      if (!line) {
        skippedLines++;
        continue;
      }

      // 解析 JSON
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn(
          { lineNo: totalLines, raw: line.slice(0, 120) },
          "ndjson-stream.invalid-json-skipped",
        );
        skippedLines++;
        continue;
      }

      // 调用行处理器
      const result = handleRow(parsed, { lineNo: totalLines, raw: line });
      if (result === undefined) {
        skippedLines++;
        continue;
      }

      batch.push(result);

      // 达到批量大小 → flush
      if (batch.length >= batchSize) {
        await onFlush(batch);
        flushedRows += batch.length;
        flushedBatches++;
        batch.length = 0;

        // 进度回调
        if (onProgress && totalLines % progressInterval === 0) {
          onProgress({ totalLines, flushedBatches });
        }
      }
    }

    // 刷出残余数据
    if (batch.length > 0) {
      await onFlush(batch);
      flushedRows += batch.length;
      flushedBatches++;
    }
  } finally {
    rl.close();
  }

  return { totalLines, skippedLines, flushedBatches, flushedRows };
}

/* ------------------------------------------------------------------ */
/*  公开 API                                                           */
/* ------------------------------------------------------------------ */

/**
 * 从 URL 流式下载并解析 NDJSON。
 * 适用于生产环境：Shopify Bulk Operation 结果 URL。
 *
 * 流程：fetch(url) → ReadableStream → Node.js Readable → 逐行解析 → 批量 flush
 *
 * @param url - Shopify Bulk Operation 结果下载 URL
 * @param options - 解析选项（行处理器 + flush 回调 + 批量大小等）
 * @returns 解析统计
 */
export async function streamNdjsonFromUrl<T>(
  url: string,
  options: StreamParserOptions<T>,
): Promise<StreamParseResult> {
  logger.info({ url: url.slice(0, 120) }, "ndjson-stream.url-fetch-start");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `NDJSON fetch failed: ${response.status} ${response.statusText}`,
    );
  }

  if (!response.body) {
    throw new Error("NDJSON fetch: response body is null");
  }

  // 将 Web ReadableStream 转换为 Node.js Readable
  const nodeStream = Readable.fromWeb(
    response.body as import("stream/web").ReadableStream,
  );

  const result = await parseFromStream(nodeStream, options);

  logger.info(result, "ndjson-stream.url-fetch-done");
  return result;
}

/**
 * 从本地文件流式解析 NDJSON。
 * 适用于 fixture 回放和本地测试。
 *
 * @param filePath - 本地 NDJSON 文件路径
 * @param options - 解析选项
 * @returns 解析统计
 */
export async function streamNdjsonFromFile<T>(
  filePath: string,
  options: StreamParserOptions<T>,
): Promise<StreamParseResult> {
  logger.info({ filePath }, "ndjson-stream.file-start");

  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const result = await parseFromStream(stream, options);

  logger.info(result, "ndjson-stream.file-done");
  return result;
}
