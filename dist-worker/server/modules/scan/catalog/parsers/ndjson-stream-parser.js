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
export class ParentIdCache {
    cache = new Map();
    /** 写入缓存 */
    set(id, value) {
        this.cache.set(id, value);
    }
    /** 读取缓存，不存在返回 undefined */
    get(id) {
        return this.cache.get(id);
    }
    /** 判断是否存在 */
    has(id) {
        return this.cache.has(id);
    }
    /** 当前缓存条目数 */
    get size() {
        return this.cache.size;
    }
    /** 获取所有条目（用于流结束后残余处理） */
    entries() {
        return this.cache.entries();
    }
    /** 清除缓存，释放内存 */
    clear() {
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
async function parseFromStream(stream, options) {
    const { batchSize = DEFAULT_BATCH_SIZE, handleRow, onFlush, onProgress, progressInterval = DEFAULT_PROGRESS_INTERVAL, } = options;
    const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
    });
    let totalLines = 0;
    let skippedLines = 0;
    let flushedBatches = 0;
    let flushedRows = 0;
    const batch = [];
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
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                logger.warn({ lineNo: totalLines, raw: line.slice(0, 120) }, "ndjson-stream.invalid-json-skipped");
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
    }
    finally {
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
export async function streamNdjsonFromUrl(url, options) {
    logger.info({ url: url.slice(0, 120) }, "ndjson-stream.url-fetch-start");
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`NDJSON fetch failed: ${response.status} ${response.statusText}`);
    }
    if (!response.body) {
        throw new Error("NDJSON fetch: response body is null");
    }
    // 将 Web ReadableStream 转换为 Node.js Readable
    const nodeStream = Readable.fromWeb(response.body);
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
export async function streamNdjsonFromFile(filePath, options) {
    logger.info({ filePath }, "ndjson-stream.file-start");
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const result = await parseFromStream(stream, options);
    logger.info(result, "ndjson-stream.file-done");
    return result;
}
