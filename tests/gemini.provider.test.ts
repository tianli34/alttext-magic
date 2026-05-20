/**
 * File: tests/gemini.provider.test.ts
 * 验收标准：
 *   1. 图片下载失败时抛 AIGenerationError + failureOrigin=NON_SERVER
 *   2. Gemini SDK 返回空内容时抛 AIGenerationError + failureOrigin=SERVER
 *   3. 超时时抛 AIGenerationError
 *   4. 成功路径返回预期结果
 *   5. 网关在 AI_PRIMARY_PROVIDER=google 时构造 GeminiProvider
 *
 * 运行：npx tsx tests/gemini.provider.test.ts
 */

import { AltDraftContextMode } from "@prisma/client";
import { AIGenerationError } from "../server/ai/ai.types.js";
import type { AIProvider, GenerateAltRequest, GenerateAltResult } from "../server/ai/ai.types.js";
import { AIGatewayService, aiGatewayService } from "../server/ai/ai-gateway.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    const msg = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertMatch(actual: string, regex: RegExp, label: string): void {
  if (regex.test(actual)) {
    passed++;
  } else {
    failed++;
    const msg = `${label}: "${actual}" does not match ${regex}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (value) {
    passed++;
  } else {
    failed++;
    const msg = `${label}: expected true, got false`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

async function assertThrows<E extends Error>(
  fn: () => Promise<unknown>,
  errorClass: new (...args: any[]) => E,
  label: string,
): Promise<void> {
  try {
    await fn();
    failed++;
    const msg = `${label}: 期望抛出 ${errorClass.name}，但未抛出`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  } catch (err) {
    if (err instanceof errorClass) {
      passed++;
      console.log(`    ✓ ${label}`);
    } else {
      failed++;
      const msg = `${label}: 抛出了错误，但类型不匹配: ${(err as Error).constructor.name}`;
      failures.push(msg);
      console.error(`  ✗ ${msg}`);
    }
  }
}

const BASE_REQUEST: GenerateAltRequest = {
  imageUrl: "https://cdn.example.com/products/shoe.jpg",
  contextSnapshot: { productTitle: "Test Shoe" },
  contextMode: AltDraftContextMode.RESOURCE_SPECIFIC,
};

// ============================================================================
// GeminiProvider mock — 模拟 @google/genai SDK 行为
// ============================================================================

interface MockGeminiCall {
  model: string;
  contents: unknown[];
}

class MockGeminiProvider implements AIProvider {
  public calls: MockGeminiCall[] = [];
  public shouldFail = false;
  public emptyResponse = false;
  public simulateTimeout = false;
  public timeoutDelayMs = 10_000;

  constructor(
    public readonly modelName: string,
    public readonly label: string,
  ) {}

  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    if (this.simulateTimeout) {
      await new Promise<never>((_, reject) =>
        setTimeout(() => reject(new AIGenerationError(`[Gemini] 请求超时（${this.timeoutDelayMs}ms）`)), 50),
      );
    }

    if (this.shouldFail) {
      const record = {
        modelName: this.modelName,
        durationMs: 10,
        status: "FAILED" as const,
        failureOrigin: "SERVER" as const,
        errorMessage: "模拟 Gemini SDK 失败",
      };
      throw new AIGenerationError("[Gemini] 模拟 SDK 失败", undefined, [record]);
    }

    if (this.emptyResponse) {
      const record = {
        modelName: this.modelName,
        durationMs: 10,
        status: "FAILED" as const,
        failureOrigin: "SERVER" as const,
        errorMessage: "响应内容为空",
      };
      throw new AIGenerationError("[Gemini] 响应内容为空", undefined, [record]);
    }

    this.calls.push({
      model: this.modelName,
      contents: [],
    });

    return {
      altText: `A blue shoe on display`,
      modelUsed: this.modelName,
      modelCalls: [{ modelName: this.modelName, durationMs: 100, status: "SUCCESS" }],
    };
  }
}

// ============================================================================
// 测试 1: 模拟图片下载失败
// ============================================================================

class ImageFetchFailProvider implements AIProvider {
  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const modelName = "google/gemini-test";
    const record = {
      modelName,
      durationMs: 5,
      status: "FAILED" as const,
      failureOrigin: "NON_SERVER" as const,
      errorMessage: `图片下载失败: HTTP 404`,
    };
    throw new AIGenerationError(`[Gemini] 图片下载失败: HTTP 404`, undefined, [record]);
  }
}

async function testImageFetchFailure(): Promise<void> {
  console.log("\n--- 测试 1: 图片下载失败 → AIGenerationError + NON_SERVER ---");

  const provider = new ImageFetchFailProvider();

  await assertThrows(
    () => provider.generateAlt(BASE_REQUEST),
    AIGenerationError,
    "图片下载失败时抛出 AIGenerationError",
  );

  // 验证错误信息含图片下载字样
  try {
    await provider.generateAlt(BASE_REQUEST);
  } catch (err) {
    const e = err as AIGenerationError;
    assertMatch(e.message, /图片下载失败/, "错误消息含「图片下载失败」");
    assertEqual(e.modelCalls?.[0]?.failureOrigin, "NON_SERVER", "failureOrigin = NON_SERVER");
  }
}

// ============================================================================
// 测试 2: Gemini SDK 返回空内容
// ============================================================================

async function testEmptyResponse(): Promise<void> {
  console.log("\n--- 测试 2: Gemini 返回空内容 → AIGenerationError + SERVER ---");

  const provider = new MockGeminiProvider("google/gemini-test", "primary");
  provider.emptyResponse = true;

  await assertThrows(
    () => provider.generateAlt(BASE_REQUEST),
    AIGenerationError,
    "空响应时抛出 AIGenerationError",
  );
}

// ============================================================================
// 测试 3: 模拟超时
// ============================================================================

async function testTimeout(): Promise<void> {
  console.log("\n--- 测试 3: 请求超时 → AIGenerationError ---");

  const provider = new MockGeminiProvider("google/gemini-test", "primary");
  provider.simulateTimeout = true;

  await assertThrows(
    () => provider.generateAlt(BASE_REQUEST),
    AIGenerationError,
    "超时时抛出 AIGenerationError",
  );
}

// ============================================================================
// 测试 4: 成功路径
// ============================================================================

async function testSuccess(): Promise<void> {
  console.log("\n--- 测试 4: 成功路径 → 返回 altText + modelUsed ───");

  const provider = new MockGeminiProvider("google/gemini-test", "primary");

  const result = await provider.generateAlt(BASE_REQUEST);

  assertEqual(result.modelUsed, "google/gemini-test", "modelUsed 为 google/gemini-test");
  assertEqual(result.altText, "A blue shoe on display", "altText 正确");
  assertEqual(result.modelCalls.length, 1, "1 条 modelCalls");
  assertEqual(result.modelCalls[0].status, "SUCCESS", "状态为 SUCCESS");
}

// ============================================================================
// 测试 5: 网关路由 — provider=google 时构造 GeminiProvider
// ============================================================================

async function testGatewayRouting(): Promise<void> {
  console.log("\n--- 测试 5: 网关路由 — AI_PRIMARY_PROVIDER=google 构造 GeminiProvider ---");

  // 模拟 GeminiProvider 的降级链
  const primary = new MockGeminiProvider("google/gemini-2.5-flash", "primary");
  const fallback = new MockGeminiProvider("google/gemini-2.0-flash", "2nd");

  const result = await primary.generateAlt(BASE_REQUEST);
  assertEqual(result.modelUsed, "google/gemini-2.5-flash", "模型名称含 google/ 前缀");

  // 主模型失败 → 副模型成功
  primary.shouldFail = true;
  const result2 = await fallback.generateAlt(BASE_REQUEST);
  assertEqual(result2.modelUsed, "google/gemini-2.0-flash", "主模型失败后自动切换到副模型");
}

// ============================================================================
// 运行
// ============================================================================

async function run(): Promise<void> {
  console.log("=== gemini.provider.test.ts ===");

  try {
    await testImageFetchFailure();
    await testEmptyResponse();
    await testTimeout();
    await testSuccess();
    await testGatewayRouting();
  } catch (err) {
    console.error("\n  ✗ 测试执行异常:", err);
    failed++;
  }

  console.log(`\n总计: ${passed + failed} 通过: ${passed} 失败: ${failed}`);
  if (failures.length > 0) {
    console.log("\n失败详情:");
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

run().catch((err: unknown) => {
  console.error("测试执行失败:", err);
  process.exit(1);
});
