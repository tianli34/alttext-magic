/**
 * File: server/modules/devtools/clear-media-alt.core.server.ts
 * Purpose: [TEMP-DEVTOOLS] 「批量清空店铺全部产品图片 alt」的核心逻辑。
 *          由 scripts/clear-media-alt.ts 抽取而来，供两个入口共用（单一真源）：
 *            1) CLI:  npx tsx scripts/clear-media-alt.ts [--shop x] [--apply]
 *            2) Dashboard 临时按钮: POST /api/dev/clear-alt/start（后台任务化，
 *               见同目录 clear-media-alt-job.server.ts）
 *
 *          机制（与原脚本一致）:
 *            1. 取得 offline access token（默认读 Session 表，临期用 refreshToken 走
 *               OAuth refresh grant 刷新并写回；Dashboard 入口改注入官方
 *               unauthenticated.admin 链路，避免与官方刷新互相抢 token）
 *            2. GraphQL 分页遍历 products → media，收集 alt 非空的 MediaImage
 *            3. fileUpdate mutation 分批把 alt 置空（与写回模块同一 mutation）
 *
 *          ⚠️ 临时性质：生产上线前需删除
 *            server/modules/devtools/ + app/routes/api.dev.clear-alt.*.tsx
 *            + app/components/dashboard/ClearMediaAltPanel.tsx
 *            + app/routes/app._index.tsx 内的 [TEMP-DEVTOOLS] 代码块
 */
import { env } from "../../config/env.js";
import prisma from "../../db/prisma.server";

// ── 常量 ──────────────────────────────────────────────────────────────
/** Shopify Admin GraphQL API 版本, 与 server/modules/writeback/mutations/mutation-utils.ts 保持一致 */
const SHOPIFY_ADMIN_API_VERSION = "2026-04";

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

/** token 过期判定余量(ms) */
const EXPIRY_BUFFER_MS = 60_000;

/** dry-run 模式回显的样本条数上限 */
const SAMPLE_LIMIT = 20;

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

/** 日志输出回调（CLI 走 console.log，Dashboard 走内存缓冲） */
export type ClearMediaAltLog = (line: string) => void;

/** 自定义 token 解析器（Dashboard 入口注入官方 offline admin 链路） */
export type ClearMediaAltTokenResolver = (
  shopDomain: string,
  log: ClearMediaAltLog,
) => Promise<string>;

export interface ClearMediaAltOptions {
  /** 目标店铺域名, 如 xxx.myshopify.com */
  shopDomain: string;
  /** false = dry-run 仅预览; true = 实际清空 */
  apply: boolean;
  /** 日志输出回调, 缺省为 console.log */
  log?: ClearMediaAltLog;
  /** 自定义 token 获取方式, 缺省为 Session 表 + refresh grant */
  resolveAccessToken?: ClearMediaAltTokenResolver;
}

/** dry-run 样本条目 */
export interface ClearMediaAltSample {
  productId: string;
  productTitle: string;
  mediaId: string;
  currentAlt: string;
}

/** 执行结果摘要 */
export interface ClearMediaAltResult {
  shopDomain: string;
  /** 是否为 dry-run（未发起任何写操作） */
  dryRun: boolean;
  /** 扫描的产品分页数 */
  scannedPages: number;
  /** alt 非空、待清空（或已清空）的图片总数 */
  pendingCount: number;
  /** 实际写回成功数（dry-run 恒为 0） */
  succeeded: number;
  /** 实际写回失败数（dry-run 恒为 0） */
  failed: number;
  /** 因单产品 media 超出上限而跳过的图片数 */
  skippedOverlimit: number;
  /** dry-run 前 SAMPLE_LIMIT 条样本 */
  samples: ClearMediaAltSample[];
}

// ── 内部工具 ──────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * 默认 token 解析: 读取 Session 表 offline_${shop}，token 已过期(或 60s 内将过期)
 * 时用 refreshToken 走 OAuth refresh grant 刷新并写回。
 * 与 scripts/clear-media-alt.ts 原实现一致（CLI 独立运行时无需拉起 shopify.server）。
 */
async function resolveOfflineAccessToken(
  shop: string,
  log: ClearMediaAltLog,
): Promise<string> {
  const sessionId = `offline_${shop}`;
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
  });

  if (!session?.accessToken) {
    throw new Error(
      `Session 表中不存在 ${sessionId}, 请先通过 OAuth 安装应用到该店铺`,
    );
  }

  // expires 为 null 的 legacy token 直接返回, 交给 401 检测
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

  // env 已由 server/config/env.ts 校验非空, 此处无需再判空
  const apiKey = env.SHOPIFY_API_KEY;
  const apiSecret = env.SHOPIFY_API_SECRET;

  log("  🔄 offline token 已过期, 使用 refreshToken 自动刷新...");
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

  log(
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
  log: ClearMediaAltLog,
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
      log(
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
        log(
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

// ── 扫描与写回 ────────────────────────────────────────────────────────
/** 分页遍历全部产品, 收集 alt 非空的 MediaImage */
async function collectPendingMedia(
  endpoint: string,
  token: string,
  log: ClearMediaAltLog,
  counters: { pages: number; skippedOverlimit: number },
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
        log,
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
        counters.skippedOverlimit += 1;
        log(
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

    log(
      `  扫描第 ${pageIndex} 页: 本页 ${products.nodes.length} 个产品, 累计待清空 ${pending.length} 张图`,
    );

    cursor = products.pageInfo.hasNextPage ? products.pageInfo.endCursor : null;
  } while (cursor !== null);

  counters.pages = pageIndex;
  return pending;
}

/** 分批调用 fileUpdate 将 alt 置空, 返回成功/失败计数 */
async function clearMediaAltBatch(
  endpoint: string,
  token: string,
  pending: PendingMedia[],
  log: ClearMediaAltLog,
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
      log,
    );

    if (result.errors?.length) {
      failed += batch.length;
      log(
        `  ❌ 批次 ${start + 1}-${start + batch.length} GraphQL 错误: ` +
          result.errors.map((e) => e.message).join("; "),
      );
    } else {
      const userErrors = result.data?.fileUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        failed += batch.length;
        log(
          `  ❌ 批次 ${start + 1}-${start + batch.length} userErrors: ` +
            userErrors.map((e) => `[${e.code ?? "?"}] ${e.message}`).join("; "),
        );
      } else {
        succeeded += batch.length;
        log(
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
/**
 * 执行「清空产品图片 alt」。
 * apply=false 仅扫描预览(不写); apply=true 分批实际清空。
 * 全过程通过 options.log 回显, 与原 CLI 输出一致。
 */
export async function runClearMediaAlt(
  options: ClearMediaAltOptions,
): Promise<ClearMediaAltResult> {
  const { shopDomain, apply } = options;
  const log: ClearMediaAltLog = options.log ?? ((line) => console.log(line));
  const resolveAccessToken: ClearMediaAltTokenResolver =
    options.resolveAccessToken ?? resolveOfflineAccessToken;

  log(`\n🧹 批量清空产品图片 alt`);
  log(`   店铺: ${shopDomain}`);
  log(`   模式: ${apply ? "⚠️ 实际执行 (--apply)" : "🔍 预览 (dry-run)"}\n`);

  // 1. 获取有效 offline token(过期则自动刷新)
  const token = await resolveAccessToken(shopDomain, log);
  const endpoint = `https://${shopDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`;

  // 2. 收集待清空媒体
  const counters = { pages: 0, skippedOverlimit: 0 };
  const pending = await collectPendingMedia(endpoint, token, log, counters);

  log(`\n📊 扫描完成: 共 ${pending.length} 张产品图片 alt 非空\n`);

  const samples: ClearMediaAltSample[] = pending
    .slice(0, SAMPLE_LIMIT)
    .map((item) => ({
      productId: item.productId,
      productTitle: item.productTitle,
      mediaId: item.mediaId,
      currentAlt: item.currentAlt,
    }));

  if (pending.length === 0) {
    log("✨ 无需处理, 退出。");
    return {
      shopDomain,
      dryRun: !apply,
      scannedPages: counters.pages,
      pendingCount: 0,
      succeeded: 0,
      failed: 0,
      skippedOverlimit: counters.skippedOverlimit,
      samples,
    };
  }

  // 预览模式: 打印样本后退出
  if (!apply) {
    for (const item of samples) {
      log(
        `  · [${item.productTitle}] ${item.mediaId} alt=${JSON.stringify(item.currentAlt.slice(0, 60))}`,
      );
    }
    if (pending.length > SAMPLE_LIMIT) {
      log(`  … 其余 ${pending.length - SAMPLE_LIMIT} 条省略`);
    }
    log(`\n🔍 dry-run 结束, 未做任何修改。确认无误后加 --apply 实际执行。`);
    return {
      shopDomain,
      dryRun: true,
      scannedPages: counters.pages,
      pendingCount: pending.length,
      succeeded: 0,
      failed: 0,
      skippedOverlimit: counters.skippedOverlimit,
      samples,
    };
  }

  // 3. 实际清空
  const { succeeded, failed } = await clearMediaAltBatch(
    endpoint,
    token,
    pending,
    log,
  );

  log(`\n🏁 完成: 成功 ${succeeded} 张, 失败 ${failed} 张`);
  return {
    shopDomain,
    dryRun: false,
    scannedPages: counters.pages,
    pendingCount: pending.length,
    succeeded,
    failed,
    skippedOverlimit: counters.skippedOverlimit,
    samples,
  };
}

