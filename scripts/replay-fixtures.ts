/**
 * File: scripts/replay-fixtures.ts
 * Purpose: Fixture 回放入口 — 使用通用流式 NDJSON 解析器离线回放 fixture 文件。
 *
 * 用法:
 *   npx tsx scripts/replay-fixtures.ts
 *   npx tsx scripts/replay-fixtures.ts --batch-size 10   # 自定义批次大小
 *   npx tsx scripts/replay-fixtures.ts --resource product_media  # 仅回放指定资源
 *
 * 此脚本不依赖数据库，仅验证流式解析器的逐行解析能力和批量 flush 机制。
 */
import { resolve } from "node:path";
import {
  streamNdjsonFromFile,
  type StreamParseResult,
} from "../server/modules/scan/catalog/parsers/ndjson-stream-parser";
import { createArticleRowHandler } from "../server/modules/scan/catalog/parsers/article.parser";
import { createCollectionRowHandler } from "../server/modules/scan/catalog/parsers/collection.parser";
import { createFilesRowHandler } from "../server/modules/scan/catalog/parsers/files.parser";
import { createProductMediaRowHandler } from "../server/modules/scan/catalog/parsers/product-media.parser";
import type { ProductMediaFlushItem } from "../server/modules/scan/catalog/parsers/staging.types";

/* ------------------------------------------------------------------ */
/*  配置                                                               */
/* ------------------------------------------------------------------ */

interface FixtureConfig {
  name: string;
  file: string;
  resourceType: string;
}

const FIXTURES: FixtureConfig[] = [
  {
    name: "Articles",
    file: "fixtures/bulk_articles.ndjson",
    resourceType: "ARTICLE_IMAGE",
  },
  {
    name: "Collections",
    file: "fixtures/bulk_collections.ndjson",
    resourceType: "COLLECTION_IMAGE",
  },
  {
    name: "Files",
    file: "fixtures/bulk_files.ndjson",
    resourceType: "FILES",
  },
  {
    name: "Product-Media",
    file: "fixtures/bulk_product_media.ndjson",
    resourceType: "PRODUCT_MEDIA",
  },
];

/* ------------------------------------------------------------------ */
/*  解析命令行参数                                                      */
/* ------------------------------------------------------------------ */

function parseArgs(): { batchSize: number; resource: string | null } {
  const args = process.argv.slice(2);
  let batchSize = 500;
  let resource: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch-size" && args[i + 1]) {
      batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--resource" && args[i + 1]) {
      resource = args[i + 1];
      i++;
    }
  }

  return { batchSize, resource };
}

/* ------------------------------------------------------------------ */
/*  回放单个 fixture                                                    */
/* ------------------------------------------------------------------ */

interface ReplayStats {
  fixture: string;
  result: StreamParseResult;
  totalFlushedItems: number;
  batchSize: number;
  batches: number[];
}

async function replayFixture(
  config: FixtureConfig,
  batchSize: number,
): Promise<ReplayStats> {
  const filePath = resolve(process.cwd(), config.file);

  // 记录每批次的大小
  const batchSizes: number[] = [];
  let totalFlushedItems = 0;

  const onFlush = async (batch: unknown[]): Promise<void> => {
    batchSizes.push(batch.length);
    totalFlushedItems += batch.length;

    // 打印批次摘要
    if (batch.length <= 3) {
      console.log(
        `    批次 #${batchSizes.length}: ${batch.length} 行`,
        JSON.stringify(batch).slice(0, 200),
      );
    } else {
      console.log(`    批次 #${batchSizes.length}: ${batch.length} 行`);
    }
  };

  let result: StreamParseResult;

  switch (config.resourceType) {
    case "ARTICLE_IMAGE": {
      const handler = createArticleRowHandler();
      result = await streamNdjsonFromFile(filePath, {
        batchSize,
        handleRow: handler,
        onFlush: onFlush as (batch: unknown[]) => Promise<void>,
        onProgress: (stats) => {
          console.log(
            `    进度: ${stats.totalLines} 行, ${stats.flushedBatches} 批次`,
          );
        },
      });
      break;
    }
    case "COLLECTION_IMAGE": {
      const handler = createCollectionRowHandler();
      result = await streamNdjsonFromFile(filePath, {
        batchSize,
        handleRow: handler,
        onFlush: onFlush as (batch: unknown[]) => Promise<void>,
      });
      break;
    }
    case "FILES": {
      const handler = createFilesRowHandler();
      result = await streamNdjsonFromFile(filePath, {
        batchSize,
        handleRow: handler,
        onFlush: onFlush as (batch: unknown[]) => Promise<void>,
      });
      break;
    }
    case "PRODUCT_MEDIA": {
      const pmHandler = createProductMediaRowHandler();
      result = await streamNdjsonFromFile<ProductMediaFlushItem>(filePath, {
        batchSize,
        handleRow: pmHandler.handleRow,
        onFlush: onFlush as (batch: unknown[]) => Promise<void>,
        onProgress: (stats) => {
          console.log(
            `    进度: ${stats.totalLines} 行, ${stats.flushedBatches} 批次, 缓存 Product ${pmHandler.getProductCache().size} 条`,
          );
        },
      });
      pmHandler.dispose();
      break;
    }
    default:
      throw new Error(`Unknown resource type: ${config.resourceType}`);
  }

  return {
    fixture: config.name,
    result,
    totalFlushedItems,
    batchSize,
    batches: batchSizes,
  };
}

/* ------------------------------------------------------------------ */
/*  主函数                                                             */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const { batchSize, resource } = parseArgs();

  console.log("=== Fixture 回放测试 ===");
  console.log(`批次大小: ${batchSize}`);
  if (resource) {
    console.log(`仅回放: ${resource}`);
  }
  console.log();

  const filtered = resource
    ? FIXTURES.filter((f) =>
        f.resourceType.toLowerCase().includes(resource.toLowerCase()),
      )
    : FIXTURES;

  if (filtered.length === 0) {
    console.log("没有匹配的 fixture");
    return;
  }

  const allStats: ReplayStats[] = [];

  for (const fixture of filtered) {
    console.log(`--- ${fixture.name} (${fixture.file}) ---`);
    try {
      const stats = await replayFixture(fixture, batchSize);
      allStats.push(stats);

      console.log(`  结果:`);
      console.log(`    总行数:       ${stats.result.totalLines}`);
      console.log(`    跳过行数:     ${stats.result.skippedLines}`);
      console.log(`    flush 批次数: ${stats.result.flushedBatches}`);
      console.log(`    flush 总行数: ${stats.result.flushedRows}`);
      console.log(`    批次详情:     [${stats.batches.join(", ")}]`);
      console.log();
    } catch (error) {
      console.error(`  ❌ 回放失败:`, error);
      console.log();
    }
  }

  // 汇总
  console.log("=== 汇总 ===");
  for (const stats of allStats) {
    console.log(
      `${stats.fixture}: ${stats.result.totalLines} 行 → ${stats.result.flushedBatches} 批次 → ${stats.result.flushedRows} 条 flush`,
    );
  }
}

main().catch((err) => {
  console.error("Fixture 回放失败:", err);
  process.exit(1);
});
