/**
 * File: scripts/clear-media-alt.ts
 * Purpose: 批量清空指定店铺全部产品图片(MediaImage)的 alt 文本。
 *
 * 机制:
 *   1. 从 Session 表读取 offline token; 已过期则用 refreshToken
 *      走 OAuth refresh grant 自动刷新并写回(项目启用了
 *      expiringOfflineAccessTokens, offline token 约 24h 过期)
 *   2. GraphQL 分页遍历 products → media, 收集 alt 非空的 MediaImage
 *   3. 通过 fileUpdate mutation 分批将 alt 置空(与写回模块同一 mutation,
 *      已在生产路径验证对 MediaImage 有效)
 *
 * 用法:
 *   npx tsx scripts/clear-media-alt.ts                     # 预览(dry-run), 不修改
 *   npx tsx scripts/clear-media-alt.ts --apply             # 实际清空
 *   npx tsx scripts/clear-media-alt.ts --shop xxx.myshopify.com --apply
 *
 * 安全约定: 默认 dry-run; 只有显式传 --apply 才会发起写操作。
 */
import "dotenv/config";
import prisma from "../server/db/prisma.server.js";

// ── 常量 ──────────────────────────────────────────────────────────────
/** Shopify Admin GraphQL API 版本, 与 server/modules/writeback/mutations/mutation-utils.ts 保持一致 */
const SHOPIFY_ADMIN_API_VERSION = "2026-04";

/** 默认目标店铺(开发店) */
const DEFAULT_SHOP = "magic-ai-test-01.myshopify.com";

/** products 分页大小 */
const PRODUCT_PAGE_SIZE = 50;

/** 单产品 media 单次拉取上限(Shopify 连接上限 250) */
const MEDIA_PAGE_SIZE = 250;

/** 单次 fileUpdate 提交的媒体数量(控制单请求成本, 便于限流恢复) */
const UPDATE_BATCH_SIZE = 20;

/** 相邻写操作之间的基础间隔(ms), 降低触发 THROTTLED 的概率 */
const WRITE_INTERVAL_MS = 500;

/** 限流/服务端错误最大重试次数 */
const MAX_RETRY = 5;

// ── GraphQL 文档 ──────────────────────────────────────────────────────
const PRODUCTS_WITH_MEDIA_QUERY = /* GraphQL */ `
  query ClearAltListProducts($after: String) {
    products(first: ${PRODUCT_PAGE_SIZE}, after: $after) {
      nodes {
        id
        title
        media(first: ${MEDIA_PAGE_SIZE}) {
          nodes {
            __typename
            ... on MediaImage {
              id
              alt
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** 与 server/modules/writeback/mutations/file-update.mutation.ts 同一 mutation */
const FILE_UPDATE_MUTATION = /* GraphQL */ `
  mutation ClearMediaAlt($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        alt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// ── 类型定义 ──────────────────────────────────────────────────────────
interface MediaNode {
  __typename: string;
  id?: string;
  alt?: string | null;
}

interface ProductNode {
  id: string;
  title: string;
  media: {
    nodes: MediaNode[];
    pageInfo: { hasNextPage: boolean };
  };
}

interface ProductsQueryData {
  products: {
    nodes: ProductNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

interface FileUpdateData {
  fileUpdate: {
    files: Array<{ id: string; alt: string | null }> | null;
    userErrors: Array<{
      field: string[] | null;
      message: string;
      code: string | null;
    }>;
  } | null;
}

interface GraphqlResponse<TData> {
  data?: TData;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

/** 待清空的媒体条目 */
interface PendingMedia {
  mediaId: string;
  productId: string;
  productTitle: string;
  currentAlt: string;
}

/** OAuth refresh grant 响应体(expiring offline tokens) */
interface RefreshGrantResponse {
  access_token: string;
  scope?: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

// ── 工具函数 ──────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 解析命令行参数: --shop <domain> / --apply */
function parseArgs(argv: string[]): { shop: string; apply: boolean } {
  let shop = DEFAULT_SHOP;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--shop") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--shop 需要跟一个店铺域名参数");
      }
      shop = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法: npx tsx scripts/clear-media-alt.ts [--shop <domain>] [--apply]\n" +
          "  默认 dry-run 预览; 传 --apply 才真正清空 alt。",
      );
      process.exit(0);
    }
  }

  return { shop, apply };
}

/** 判断 userError / GraphQL error 是否属于可重试的限流类错误 */
function isThrottled(message: string, code?: string | null): boolean {
  const upperCode = (code ?? "").toUpperCase();
  const lowerMsg = message.toLowerCase();
  return (
    upperCode.includes("THROTTLED") ||
    lowerMsg.includes("throttl") ||
    lowerMsg.includes("too many")
  );
}

/**
 * 获取有效的 offline access token。
 * token 已过期(或 60s 内将过期)时用 refreshToken 走 OAuth refresh grant
 * 刷新并写回 Session 表; 刷新失败则提示重新授权安装。
 */
async function getValidOfflineToken(shop: string): Promise<string> {
  const sessionId = `offline_${shop}`;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session?.accessToken) {
    throw new Error(
      `Session 表中不存在 ${sessionId}, 请先通过 OAuth 安装应用到该店铺`,
    );
  }

  // 留 60s 余量; expires 为 null 的 legacy token 直接返回, 交给 401 检测
  const EXPIRY_BUFFER_MS = 60_000;
  if (!session.expires) {
    return session.accessToken;
  }
  if (session.expires.getTime() - Date.now() > EXPIRY_BUFFER_MS) {
    return session.accessToken;
  }

  // 已过期: 用 refreshToken 换新
  if (!session.refreshToken) {
    throw new Error(
      "offline token 已过期且无 refreshToken, 请重新走 OAuth 授权(shopify app dev 打开应用)",
    );
  }
  if (
    session.refreshTokenExpires &&
    session.refreshTokenExpires.getTime() <= Date.now()
  ) {
    throw new Error(
      `refreshToken 已于 ${session.refreshTokenExpires.toISOString()} 过期, 请重新授权安装应用`,
    );
  }

  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("缺少 SHOPIFY_API_KEY / SHOPIFY_API_SECRET 环境变量");
  }

  console.log("  🔄 offline token 已过期, 使用 refreshToken 自动刷新...");
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `刷新 token 失败(HTTP ${response.status}): ${body}。请重新授权安装应用`,
    );
  }

  const grant = (await response.json()) as RefreshGrantResponse;
  const newExpires = new Date(Date.now() + grant.expires_in * 1000);
  const newRefreshExpires = grant.refresh_token_expires_in
    ? new Date(Date.now() + grant.refresh_token_expires_in * 1000)
    : null;

  await prisma.session.update({
    where: { id: sessionId },
    data: {
      accessToken: grant.access_token,
      expires: newExpires,
      ...(grant.scope ? { scope: grant.scope } : {}),
      ...(grant.refresh_token ? { refreshToken: grant.refresh_token } : {}),
      ...(newRefreshExpires ? { refreshTokenExpires: newRefreshExpires } : {}),
    },
  });

  console.log(
    `  ✅ token 已刷新并写回 Session 表, 新过期时间 ${newExpires.toISOString()}`,
  );
  return grant.access_token;
}

/**
 * 带限流重试的 Admin GraphQL 调用。
 * 401/403 直接抛出(不可重试); 429/5xx/THROTTLED 指数退避重试。
 */
async function adminGraphql<TData>(
  endpoint: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<GraphqlResponse<TData>> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (response.status === 401 || response.status === 403) {
      const body = await response.text();
      throw new Error(
        `认证/授权失效(HTTP ${response.status}), 店铺需重新授权: ${body}`,
      );
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`可重试 HTTP 错误: ${response.status}`);
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.warn(
        `  ⏳ 第 ${attempt}/${MAX_RETRY} 次限流/服务端错误, ${backoffMs}ms 后重试...`,
      );
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GraphQL HTTP 错误: ${response.status} ${body}`);
    }

    const payload = (await response.json()) as GraphqlResponse<TData>;

    // 响应级 THROTTLED 错误同样走重试
    if (payload.errors?.length) {
      const throttled = payload.errors.some((e) =>
        isThrottled(e.message, e.extensions?.code),
      );
      if (throttled && attempt < MAX_RETRY) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        console.warn(
          `  ⏳ 第 ${attempt}/${MAX_RETRY} 次 GraphQL THROTTLED, ${backoffMs}ms 后重试...`,
        );
        await sleep(backoffMs);
        continue;
      }
    }

    return payload;
  }

  throw lastError ?? new Error("GraphQL 请求重试次数耗尽");
}

/** 分页遍历全部产品, 收集 alt 非空的 MediaImage */
async function collectPendingMedia(
  endpoint: string,
  token: string,
): Promise<PendingMedia[]> {
  const pending: PendingMedia[] = [];
  let cursor: string | null = null;
  let pageIndex = 0;

  do {
    const result: GraphqlResponse<ProductsQueryData> =
      await adminGraphql<ProductsQueryData>(
        endpoint,
        token,
        PRODUCTS_WITH_MEDIA_QUERY,
        { after: cursor },
      );

    if (result.errors?.length) {
      throw new Error(
        `查询产品失败: ${result.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const products: ProductsQueryData["products"] | undefined =
      result.data?.products;
    if (!products) {
      throw new Error("查询产品返回空 payload");
    }

    pageIndex += 1;
    for (const product of products.nodes) {
      if (product.media.pageInfo.hasNextPage) {
        console.warn(
          `  ⚠️ 产品「${product.title}」媒体超过 ${MEDIA_PAGE_SIZE} 个, 超出部分本次跳过`,
        );
      }
      for (const media of product.media.nodes) {
        if (
          media.__typename === "MediaImage" &&
          media.id &&
          media.alt !== null &&
          media.alt !== undefined &&
          media.alt !== ""
        ) {
          pending.push({
            mediaId: media.id,
            productId: product.id,
            productTitle: product.title,
            currentAlt: media.alt,
          });
        }
      }
    }

    console.log(
      `  扫描第 ${pageIndex} 页: 本页 ${products.nodes.length} 个产品, 累计待清空 ${pending.length} 张图`,
    );

    cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;
  } while (cursor !== null);

  return pending;
}

/** 分批调用 fileUpdate 将 alt 置空, 返回成功/失败计数 */
async function clearMediaAltBatch(
  endpoint: string,
  token: string,
  pending: PendingMedia[],
): Promise<{ succeeded: number; failed: number }> {
  let succeeded = 0;
  let failed = 0;

  for (let start = 0; start < pending.length; start += UPDATE_BATCH_SIZE) {
    const batch = pending.slice(start, start + UPDATE_BATCH_SIZE);
    const result = await adminGraphql<FileUpdateData>(
      endpoint,
      token,
      FILE_UPDATE_MUTATION,
      { files: batch.map((item) => ({ id: item.mediaId, alt: "" })) },
    );

    if (result.errors?.length) {
      failed += batch.length;
      console.error(
        `  ❌ 批次 ${start + 1}-${start + batch.length} GraphQL 错误: ` +
          result.errors.map((e) => e.message).join("; "),
      );
    } else {
      const userErrors = result.data?.fileUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        failed += batch.length;
        console.error(
          `  ❌ 批次 ${start + 1}-${start + batch.length} userErrors: ` +
            userErrors.map((e) => `[${e.code ?? "?"}] ${e.message}`).join("; "),
        );
      } else {
        succeeded += batch.length;
        console.log(
          `  ✅ 已清空 ${start + 1}-${start + batch.length} / ${pending.length}`,
        );
      }
    }

    // 相邻批次之间留出间隔, 降低触发限流的概率
    if (start + UPDATE_BATCH_SIZE < pending.length) {
      await sleep(WRITE_INTERVAL_MS);
    }
  }

  return { succeeded, failed };
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { shop, apply } = parseArgs(process.argv.slice(2));

  console.log(`\n🧹 批量清空产品图片 alt`);
  console.log(`   店铺: ${shop}`);
  console.log(`   模式: ${apply ? "⚠️ 实际执行 (--apply)" : "🔍 预览 (dry-run)"}\n`);

  // 1. 获取有效 offline token(过期则自动刷新)
  const token = await getValidOfflineToken(shop);

  const endpoint = `https://${shop}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;

  // 2. 收集待清空媒体
  const pending = await collectPendingMedia(endpoint, token);

  console.log(`\n📊 扫描完成: 共 ${pending.length} 张产品图片 alt 非空\n`);

  if (pending.length === 0) {
    console.log("✨ 无需处理, 退出。");
    return;
  }

  // 预览模式: 打印前 20 条样本后退出
  if (!apply) {
    for (const item of pending.slice(0, 20)) {
      console.log(
        `  · [${item.productTitle}] ${item.mediaId} alt=${JSON.stringify(item.currentAlt.slice(0, 60))}`,
      );
    }
    if (pending.length > 20) {
      console.log(`  … 其余 ${pending.length - 20} 条省略`);
    }
    console.log(`\n🔍 dry-run 结束, 未做任何修改。确认无误后加 --apply 实际执行。`);
    return;
  }

  // 3. 实际清空
  const { succeeded, failed } = await clearMediaAltBatch(
    endpoint,
    token,
    pending,
  );

  console.log(`\n🏁 完成: 成功 ${succeeded} 张, 失败 ${failed} 张`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error("❌ 执行失败:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
