/**
 * scripts/run-bulk-query.ts
 * 直接用 fetch + access token 调用 Shopify Admin GraphQL API
 * 绕过 shopify-api 客户端封装，避免 401 问题
 */
import { parseProductMediaNdjson } from "../server/modules/scan/catalog/parsers/product-media.parser";
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { createInterface } from "readline";

import {
  BULK_QUERY_PRODUCT_MEDIA,
  BULK_QUERY_FILES,
  BULK_QUERY_COLLECTIONS,
  BULK_QUERY_ARTICLES,
} from "../app/lib/bulk/queries";

// ═══════════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════════

type QueryName = "PRODUCT_MEDIA" | "FILES" | "COLLECTIONS" | "ARTICLES";

type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "CANCELING"
  | "EXPIRED";

interface UserError {
  field: string[];
  message: string;
}

interface BulkOperationRunResult {
  data: {
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  };
  errors?: Array<{ message: string }>;
}

interface CurrentBulkOperationResult {
  data: {
    currentBulkOperation: {
      id: string;
      status: BulkOperationStatus;
      errorCode: string | null;
      url: string | null;
      objectCount: string;
    } | null;
  };
  errors?: Array<{ message: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════════════════════

const QUERY_MAP: Record<QueryName, string> = {
  PRODUCT_MEDIA: BULK_QUERY_PRODUCT_MEDIA,
  FILES: BULK_QUERY_FILES,
  COLLECTIONS: BULK_QUERY_COLLECTIONS,
  ARTICLES: BULK_QUERY_ARTICLES,
};

const OUTPUT_MAP: Record<QueryName, string> = {
  PRODUCT_MEDIA: "bulk_product_media.ndjson",
  FILES: "bulk_files.ndjson",
  COLLECTIONS: "bulk_collections.ndjson",
  ARTICLES: "bulk_articles.ndjson",
};

// Shopify Admin API 版本，与 shopify.server.ts 保持一致
const API_VERSION = "2026-04";

const POLL_INTERVAL_MS = 3_000;
const MAX_WAIT_MS = 30 * 60 * 1_000;

// ═══════════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg: string): void {
  console.error(`[${new Date().toISOString()}] ❌ ${msg}`);
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(destPath);
    proto
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`下载失败，HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", (e) => {
          fs.unlink(destPath, () => { });
          reject(e);
        });
      })
      .on("error", (e) => {
        fs.unlink(destPath, () => { });
        reject(e);
      });
  });
}

async function countLines(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const rl = createInterface({ input: fs.createReadStream(filePath) });
    rl.on("line", (line) => {
      if (line.trim()) count++;
    });
    rl.on("close", () => resolve(count));
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shopify GraphQL 请求（原生 fetch，无封装）
// ═══════════════════════════════════════════════════════════════════════════════

async function shopifyGraphql<T>(
  shop: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Shopify Admin API 用 X-Shopify-Access-Token
      "X-Shopify-Access-Token": accessToken.trim(),
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `HTTP ${response.status} ${response.statusText}\n` +
      `URL: ${url}\n` +
      `响应体: ${body.slice(0, 500)}`
    );
  }

  const json = (await response.json()) as T;
  return json;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session 加载
// ═══════════════════════════════════════════════════════════════════════════════
async function loadAccessToken(shop: string): Promise<string> {
  const { default: prisma } = await import("../app/db.server");
  const sessionId = `offline_${shop}`;

  const record = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!record?.accessToken) throw new Error(`缺少 Session/accessToken: ${sessionId}`);

  // 非 expiring offline token：expires 可能是 null，直接用
  const now = Date.now();
  const expiresAt = record.expires?.getTime() ?? null;

  const SHOULD_REFRESH_BUFFER_MS = 2 * 60 * 1000; // 提前 2 分钟刷新

  if (!expiresAt || expiresAt - now > SHOULD_REFRESH_BUFFER_MS) {
    return record.accessToken.trim();
  }

  if (!record.refreshToken) {
    throw new Error(`accessToken 已过期但 refreshToken 为空；需要重新授权/重装 app`);
  }

  const refreshed = await refreshOfflineAccessToken(shop, record.refreshToken);

  const newExpires = new Date(now + refreshed.expires_in * 1000);
  const newRefreshExpires = new Date(now + refreshed.refresh_token_expires_in * 1000);

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      accessToken: refreshed.access_token,
      expires: newExpires,
      refreshToken: refreshed.refresh_token,
      refreshTokenExpires: newRefreshExpires,
    },
  });

  return refreshed.access_token.trim();
}


type RefreshResponse = {
  access_token: string;
  expires_in: number; // seconds
  refresh_token: string;
  refresh_token_expires_in: number; // seconds
  scope: string;
};

async function refreshOfflineAccessToken(shop: string, refreshToken: string) {
  const url = `https://${shop}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY!,
    client_secret: process.env.SHOPIFY_API_SECRET!,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Refresh 失败: HTTP ${resp.status}\n${text}`);

  return JSON.parse(text) as RefreshResponse;
}






// ═══════════════════════════════════════════════════════════════════════════════
// Bulk Operation 逻辑
// ═══════════════════════════════════════════════════════════════════════════════

async function startBulkOperation(
  shop: string,
  accessToken: string,
  queryBody: string
): Promise<string> {
  const mutation = `
    mutation RunBulkOperation($query: String!) {
      bulkOperationRunQuery(query: $query) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const result = await shopifyGraphql<BulkOperationRunResult>(
    shop,
    accessToken,
    mutation,
    { query: queryBody }
  );

  // GraphQL 层错误
  if (result.errors?.length) {
    throw new Error(
      `GraphQL 错误：\n` +
      result.errors.map((e) => `  ${e.message}`).join("\n")
    );
  }

  const { bulkOperation, userErrors } =
    result.data.bulkOperationRunQuery;

  if (userErrors.length > 0) {
    const messages = userErrors
      .map((e: UserError) => `  [${e.field.join(".")}] ${e.message}`)
      .join("\n");
    throw new Error(`Bulk Operation 提交失败：\n${messages}`);
  }

  if (!bulkOperation?.id) {
    throw new Error("未返回 Bulk Operation ID：" + JSON.stringify(result.data));
  }

  log(`✅ 已提交，ID: ${bulkOperation.id}，状态: ${bulkOperation.status}`);
  return bulkOperation.id;
}

async function pollUntilComplete(
  shop: string,
  accessToken: string
): Promise<string> {
  const pollQuery = `
    query {
      currentBulkOperation {
        id
        status
        errorCode
        url
        objectCount
      }
    }
  `;

  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > MAX_WAIT_MS) {
      throw new Error(`超过最大等待时间 ${MAX_WAIT_MS / 60_000} 分钟`);
    }

    await sleep(POLL_INTERVAL_MS);

    const result = await shopifyGraphql<CurrentBulkOperationResult>(
      shop,
      accessToken,
      pollQuery
    );

    if (result.errors?.length) {
      throw new Error(result.errors.map((e) => e.message).join(", "));
    }

    const op = result.data.currentBulkOperation;
    if (!op) throw new Error("currentBulkOperation 为 null");

    log(`⏳ 状态: ${op.status}，对象数: ${op.objectCount}`);

    switch (op.status) {
      case "COMPLETED":
        if (!op.url) throw new Error("完成但 URL 为空（无匹配数据）");
        log(`✅ 完成！共 ${op.objectCount} 个对象`);
        return op.url;

      case "FAILED":
        throw new Error(`失败，errorCode: ${op.errorCode ?? "unknown"}`);

      case "CANCELED":
      case "EXPIRED":
        throw new Error(`状态异常: ${op.status}`);

      case "CREATED":
      case "RUNNING":
      case "CANCELING":
        break;

      default: {
        const _exhaustive: never = op.status;
        log(`⚠️  未知状态: ${_exhaustive}`);
      }
    }
  }
}



async function verifyProductMedia(filePath: string): Promise<void> {
  const products = await parseProductMediaNdjson(filePath);

  let totalMedia = 0;
  const seenMediaIds = new Set<string>();
  let duplicateCount = 0;
  let positionError = 0;

  for (const product of products) {
    log(`  📦 ${product.title} (${product.id})`);
    log(`     media 数量: ${product.media.length}`);

    for (const m of product.media) {
      totalMedia++;

      // 验证 position_index 连续且从 1 开始
      const expectedPosition = product.media.indexOf(m) + 1;
      if (m.position_index !== expectedPosition) {
        logError(
          `position_index 异常: ${m.id} 期望 ${expectedPosition}，实际 ${m.position_index}`
        );
        positionError++;
      }

      // 检测跨 product 的 MediaImage 共享
      if (seenMediaIds.has(m.id)) {
        duplicateCount++;
        log(`  ⚠️  共享 MediaImage: ${m.id} 出现在多个 product`);
      }
      seenMediaIds.add(m.id);

      log(
        `     [${m.position_index}] ${m.id} alt="${m.alt ?? ""}" ` +
        `${m.image?.url?.slice(0, 60) ?? "(无图)"}`
      );
    }
  }

  log(`\n  📊 汇总:`);
  log(`     产品数: ${products.length}`);
  log(`     媒体总数: ${totalMedia}`);
  log(`     唯一 MediaImage: ${seenMediaIds.size}`);
  log(`     共享 MediaImage 实例数: ${duplicateCount}`);
  log(`     position_index 错误数: ${positionError}`);

  if (positionError === 0 && duplicateCount === 0) {
    log(`  ✅ 验证全部通过`);
  } else {
    logError(`  验证发现问题，请检查上方日志`);
  }
}



// ═══════════════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  // ── 参数校验 ──────────────────────────────────────────────────────────────
  const rawArg = process.argv[2]?.toUpperCase();
  if (!rawArg || !(rawArg in QUERY_MAP)) {
    logError(
      `用法：npx tsx scripts/run-bulk-query.ts <queryName>\n` +
      `可选值：${Object.keys(QUERY_MAP).join(" | ")}`
    );
    process.exit(1);
  }
  const queryName = rawArg as QueryName;

  // ── 环境变量校验 ──────────────────────────────────────────────────────────
  const missingEnv = ["TARGET_SHOP"].filter((k) => !process.env[k]);
  if (missingEnv.length > 0) {
    logError(`缺少环境变量：${missingEnv.join(", ")}`);
    process.exit(1);
  }

  const shop = process.env.TARGET_SHOP!;
  const fixturesDir = path.resolve(process.cwd(), "fixtures");
  const outputPath = path.join(fixturesDir, OUTPUT_MAP[queryName]);

  log(`📋 查询类型: ${queryName}`);
  log(`🏪 目标店铺: ${shop}`);
  log(`💾 输出文件: ${outputPath}`);

  // ── 加载 access token ─────────────────────────────────────────────────────
  log(`🔑 从数据库加载 access token...`);
  const accessToken = await loadAccessToken(shop);
  log(`✅ access token 加载成功`);

  // ── 提交 Bulk Operation ───────────────────────────────────────────────────
  log(`🚀 提交 Bulk Operation...`);
  await startBulkOperation(shop, accessToken, QUERY_MAP[queryName]);

  // ── 轮询 ──────────────────────────────────────────────────────────────────
  log(`⏳ 轮询状态（每 ${POLL_INTERVAL_MS / 1000}s）...`);
  const downloadUrl = await pollUntilComplete(shop, accessToken);

  // ── 下载 ──────────────────────────────────────────────────────────────────
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  log(`⬇️  下载 NDJSON...`);
  await downloadFile(downloadUrl, outputPath);

  const lineCount = await countLines(outputPath);
  const fileSizeKB = (fs.statSync(outputPath).size / 1024).toFixed(1);

  log(`\n${"═".repeat(60)}`);
  log(`✅ 完成！`);
  log(`   文件: ${outputPath}`);
  log(`   行数: ${lineCount}，大小: ${fileSizeKB} KB`);
  log(`${"═".repeat(60)}`);

  // ── 解析验证（仅 PRODUCT_MEDIA，必须在下载完成后）────────────────────────
  if (queryName === "PRODUCT_MEDIA") {
    log(`\n🔍 验证 position_index 推导...`);
    await verifyProductMedia(outputPath);
  }

  // log(`\n下一步脱敏：node scripts/anonymize-fixture.js ${outputPath} ${outputPath}`);
}

main().catch((error) => {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
});