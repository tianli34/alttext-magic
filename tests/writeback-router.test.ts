/**
 * File: tests/writeback-router.test.ts
 * Purpose: WritebackRouter 与三个 Mutation Executor 的单元测试。
 *
 * 运行: node --import tsx tests/writeback-router.test.ts
 */

import { AltPlane } from "@prisma/client";
import type { Session } from "@shopify/shopify-api";
import { WritebackRouter } from "../server/modules/writeback/writeback-router.js";
import { ArticleAltExecutor } from "../server/modules/writeback/mutations/article-update.mutation.js";
import { CollectionAltExecutor } from "../server/modules/writeback/mutations/collection-update.mutation.js";
import { FileAltExecutor } from "../server/modules/writeback/mutations/file-update.mutation.js";
import type {
  ShopifyGraphqlExecutor,
  ShopifyGraphqlResponse,
  WritebackResult,
} from "../server/modules/writeback/writeback.types.js";

let passed = 0;
let failed = 0;

function assertTrue(value: boolean, label: string): void {
  if (value) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(`    ✗ ${label}: 期望 true，实际 false`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(
      `    ✗ ${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}

function assertContains(actual: string, expected: string, label: string): void {
  if (actual.includes(expected)) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(`    ✗ ${label}: ${JSON.stringify(actual)} 不包含 ${JSON.stringify(expected)}`);
  }
}

const testSession = {
  id: "offline_test-shop.myshopify.com",
  shop: "test-shop.myshopify.com",
  state: "",
  isOnline: false,
  accessToken: "shpat_test",
} as Session;

type CapturedCall = {
  query: string;
  variables: Record<string, unknown>;
};

type GraphqlCallParams = Parameters<ShopifyGraphqlExecutor>[0];

function makeMockGraphql<TData>(
  response: ShopifyGraphqlResponse<TData>,
  calls: CapturedCall[],
): ShopifyGraphqlExecutor {
  return async <TResult>(params: GraphqlCallParams) => {
    calls.push({ query: params.query, variables: params.variables });
    return response as unknown as ShopifyGraphqlResponse<TResult>;
  };
}

function makeThrowingGraphql(message: string): ShopifyGraphqlExecutor {
  return async () => {
    throw new TypeError(message);
  };
}

async function testRouter(): Promise<void> {
  console.log("\n--- Router: FILE_ALT 返回 FileAltExecutor ---");
  const router = new WritebackRouter(async <TData>() => ({ data: {} as TData }));
  assertTrue(
    router.getExecutor(AltPlane.FILE_ALT) instanceof FileAltExecutor,
    "FILE_ALT executor 类型正确",
  );
}

async function testFileSuccess(): Promise<void> {
  console.log("\n--- FileAltExecutor: success ---");
  const calls: CapturedCall[] = [];
  const executor = new FileAltExecutor(
    makeMockGraphql(
      {
        data: {
          fileUpdate: {
            files: [
              {
                id: "gid://shopify/MediaImage/1",
                alt: "New alt",
                fileStatus: "READY",
              },
            ],
            userErrors: [],
          },
        },
      },
      calls,
    ),
  );

  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/MediaImage/1",
    altText: "New alt",
  });

  assertEqual(result.success, true, "返回 success=true");
  assertContains(calls[0]!.query, "fileUpdate", "调用 fileUpdate mutation");
  assertEqual(
    JSON.stringify(calls[0]!.variables),
    JSON.stringify({ files: [{ id: "gid://shopify/MediaImage/1", alt: "New alt" }] }),
    "变量包含 MediaImage GID 与 alt",
  );
}

async function testFileUserError(): Promise<void> {
  console.log("\n--- FileAltExecutor: userErrors ---");
  const executor = new FileAltExecutor(
    makeMockGraphql(
      {
        data: {
          fileUpdate: {
            files: [],
            userErrors: [
              {
                field: ["files", "0", "alt"],
                message: "Alt text is too long",
                code: "ALT_VALUE_LIMIT_EXCEEDED",
              },
            ],
          },
        },
      },
      [],
    ),
  );

  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/MediaImage/1",
    altText: "New alt",
  });

  assertFailure(result, false, "ALT_VALUE_LIMIT_EXCEEDED");
}

async function testFileNetworkError(): Promise<void> {
  console.log("\n--- FileAltExecutor: networkError ---");
  const executor = new FileAltExecutor(makeThrowingGraphql("fetch failed"));
  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/MediaImage/1",
    altText: "New alt",
  });
  assertFailure(result, true, "fetch failed");
}

async function testCollectionSuccess(): Promise<void> {
  console.log("\n--- CollectionAltExecutor: success ---");
  const calls: CapturedCall[] = [];
  const executor = new CollectionAltExecutor(
    makeMockGraphql(
      {
        data: {
          collectionUpdate: {
            collection: {
              id: "gid://shopify/Collection/1",
              image: { altText: "New alt" },
            },
            userErrors: [],
          },
        },
      },
      calls,
    ),
  );

  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/Collection/1",
    altText: "New alt",
  });

  assertEqual(result.success, true, "返回 success=true");
  assertContains(calls[0]!.query, "collectionUpdate", "调用 collectionUpdate mutation");
  assertEqual(
    JSON.stringify(calls[0]!.variables),
    JSON.stringify({
      input: {
        id: "gid://shopify/Collection/1",
        image: { altText: "New alt" },
      },
    }),
    "变量包含 Collection GID 与 image.altText",
  );
}

async function testCollectionUserError(): Promise<void> {
  console.log("\n--- CollectionAltExecutor: userErrors ---");
  const executor = new CollectionAltExecutor(
    makeMockGraphql(
      {
        data: {
          collectionUpdate: {
            collection: null,
            userErrors: [{ field: ["id"], message: "Collection does not exist" }],
          },
        },
      },
      [],
    ),
  );

  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/Collection/1",
    altText: "New alt",
  });

  assertFailure(result, false, "Collection does not exist");
}

async function testCollectionNetworkError(): Promise<void> {
  console.log("\n--- CollectionAltExecutor: networkError ---");
  const executor = new CollectionAltExecutor(makeThrowingGraphql("socket hang up"));
  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/Collection/1",
    altText: "New alt",
  });
  assertFailure(result, true, "socket hang up");
}

async function testArticleSuccess(): Promise<void> {
  console.log("\n--- ArticleAltExecutor: success ---");
  const calls: CapturedCall[] = [];
  const executor = new ArticleAltExecutor(
    makeMockGraphql(
      {
        data: {
          articleUpdate: {
            article: {
              id: "gid://shopify/Article/1",
              image: { altText: "New alt" },
            },
            userErrors: [],
          },
        },
      },
      calls,
    ),
  );

  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/Article/1",
    altText: "New alt",
  });

  assertEqual(result.success, true, "返回 success=true");
  assertContains(calls[0]!.query, "articleUpdate", "调用 articleUpdate mutation");
  assertEqual(
    JSON.stringify(calls[0]!.variables),
    JSON.stringify({
      id: "gid://shopify/Article/1",
      article: { image: { altText: "New alt" } },
    }),
    "变量包含 Article GID 与 image.altText",
  );
}

async function testArticleUserError(): Promise<void> {
  console.log("\n--- ArticleAltExecutor: userErrors ---");
  const executor = new ArticleAltExecutor(
    makeMockGraphql(
      {
        data: {
          articleUpdate: {
            article: null,
            userErrors: [
              {
                field: ["article", "image"],
                message: "Image is temporarily processing",
                code: "PROCESSING",
              },
            ],
          },
        },
      },
      [],
    ),
  );

  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/Article/1",
    altText: "New alt",
  });

  assertFailure(result, true, "PROCESSING");
}

async function testArticleNetworkError(): Promise<void> {
  console.log("\n--- ArticleAltExecutor: networkError ---");
  const executor = new ArticleAltExecutor(makeThrowingGraphql("ECONNRESET"));
  const result = await executor.execute({
    session: testSession,
    shopifyGid: "gid://shopify/Article/1",
    altText: "New alt",
  });
  assertFailure(result, true, "ECONNRESET");
}

function assertFailure(
  result: WritebackResult,
  retryable: boolean,
  expectedErrorPart: string,
): void {
  assertEqual(result.success, false, "返回 success=false");
  if (result.success) return;
  assertEqual(result.retryable, retryable, "retryable 分类正确");
  assertContains(result.error, expectedErrorPart, "错误信息包含关键内容");
}

async function run(): Promise<void> {
  console.log("\n=== writeback-router.test.ts ===");

  try {
    await testRouter();
    await testFileSuccess();
    await testFileUserError();
    await testFileNetworkError();
    await testCollectionSuccess();
    await testCollectionUserError();
    await testCollectionNetworkError();
    await testArticleSuccess();
    await testArticleUserError();
    await testArticleNetworkError();
  } catch (err) {
    failed++;
    console.error("\n  ✗ 测试执行异常:", err);
  }

  console.log(`\n  总计: ${passed + failed} 项, 通过: ${passed}, 失败: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
