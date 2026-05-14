/**
 * File: tests/ai-gateway.test.ts
 * 验收标准：
 *   1. FakeAIProvider 对相同 imageUrl 返回确定性结果
 *   2. 主模型超时 → 自动 fallback 到副模型 → 返回成功 + modelUsed 为副模型
 *   3. 主模型 + 副模型均失败 → 抛出 AIGenerationError
 *
 * 运行：npx tsx tests/ai-gateway.test.ts
 */

import { AltDraftContextMode } from "@prisma/client";
import { AIGenerationError } from "../server/ai/ai.types.js";
import type { AIProvider, GenerateAltRequest, GenerateAltResult } from "../server/ai/ai.types.js";
import { FakeAIProvider } from "../server/ai/providers/fake.provider.js";
import { FallbackProvider } from "../server/ai/providers/fallback.provider.js";

// ============================================================================
// 辅助
// ============================================================================

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(`    ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(value: boolean, label: string): void {
  if (value) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(`    ✗ ${label}: expected true, got false`);
  }
}

/** 断言 fn 抛出特定类型的错误 */
async function assertThrows<E extends Error>(
  fn: () => Promise<unknown>,
  errorClass: new (...args: unknown[]) => E,
  label: string,
): Promise<void> {
  try {
    await fn();
    failed++;
    console.error(`    ✗ ${label}: 期望抛出 ${errorClass.name}，但未抛出`);
  } catch (err) {
    if (err instanceof errorClass) {
      passed++;
      console.log(`    ✓ ${label}`);
    } else {
      failed++;
      console.error(`    ✗ ${label}: 抛出了错误，但类型不匹配: ${(err as Error).constructor.name}`);
    }
  }
}

// ============================================================================
// 测试请求基础数据
// ============================================================================

const BASE_REQUEST: GenerateAltRequest = {
  imageUrl: "https://cdn.shopify.com/products/blue-sneakers.jpg",
  contextSnapshot: { productTitle: "蓝色运动鞋", productHandle: "blue-sneakers" },
  contextMode: AltDraftContextMode.RESOURCE_SPECIFIC,
};

// ============================================================================
// Mock Provider 工具
// ============================================================================

/** 立即失败的 Provider */
class FailingProvider implements AIProvider {
  readonly name: string;
  constructor(name: string) { this.name = name; }
  async generateAlt(_req: GenerateAltRequest): Promise<GenerateAltResult> {
    throw new AIGenerationError(`[${this.name}] 模拟失败`);
  }
}

/** 立即成功的 Provider */
class SucceedingProvider implements AIProvider {
  readonly name: string;
  constructor(name: string) { this.name = name; }
  async generateAlt(_req: GenerateAltRequest): Promise<GenerateAltResult> {
    return { altText: `Result from ${this.name}`, modelUsed: this.name };
  }
}

/** 模拟超时（延迟超过 30s）的 Provider —— 通过 FakeAIProvider 的特殊 URL 机制 */
class TimeoutProvider implements AIProvider {
  constructor(private readonly delayMs: number) {}
  async generateAlt(_req: GenerateAltRequest): Promise<GenerateAltResult> {
    await new Promise<void>((_, reject) => {
      setTimeout(() => reject(new AIGenerationError("模拟超时")), this.delayMs);
    });
    // 永远不会到达
    return { altText: "", modelUsed: "" };
  }
}

// ============================================================================
// 测试 1: FakeAIProvider — 确定性结果
// ============================================================================

async function testFakeAIProviderDeterministic(): Promise<void> {
  console.log("\n--- 测试 1: FakeAIProvider 确定性结果 ---");

  const provider = new FakeAIProvider();
  const req = { ...BASE_REQUEST, imageUrl: "https://cdn.shopify.com/products/red-hat.jpg" };

  const result1 = await provider.generateAlt(req);
  const result2 = await provider.generateAlt(req);

  assertEqual(result1.altText, result2.altText, "相同 imageUrl 返回相同 altText");
  assertEqual(result1.altText, "Fake alt for red-hat.jpg", "altText 格式为 Fake alt for {filename}");
  assertEqual(result1.modelUsed, "fake-model", "modelUsed 为 fake-model");
  assertEqual(result2.modelUsed, "fake-model", "第二次 modelUsed 一致");
}

// ============================================================================
// 测试 2: FakeAIProvider — 模拟失败
// ============================================================================

async function testFakeAIProviderSimulatedFailure(): Promise<void> {
  console.log("\n--- 测试 2: FakeAIProvider 模拟失败 ---");

  const provider = new FakeAIProvider();
  const req = { ...BASE_REQUEST, imageUrl: "https://cdn.shopify.com/trigger-fake-failure/img.jpg" };

  await assertThrows(
    () => provider.generateAlt(req),
    Error,
    "包含 trigger-fake-failure 的 URL 抛出错误",
  );
}

// ============================================================================
// 测试 3: FallbackProvider — 主模型超时 → 副模型成功
// ============================================================================

async function testFallbackOnPrimaryTimeout(): Promise<void> {
  console.log("\n--- 测试 3: 主模型超时 → 自动切换副模型 ---");

  // 主模型：立即以超时错误拒绝
  const primary = new TimeoutProvider(0);
  // 副模型：立即成功
  const secondary = new SucceedingProvider("gpt-4o-mini/fallback");

  const fallback = new FallbackProvider(primary, secondary, "primary", "fallback");
  const result = await fallback.generateAlt(BASE_REQUEST);

  assertEqual(result.modelUsed, "gpt-4o-mini/fallback", "modelUsed 为副模型");
  assertEqual(result.altText, "Result from gpt-4o-mini/fallback", "altText 来自副模型");
  assertTrue(result.altText.length > 0, "altText 非空");
}

// ============================================================================
// 测试 4: FallbackProvider — 主模型失败（5xx）→ 副模型成功
// ============================================================================

async function testFallbackOnPrimaryError(): Promise<void> {
  console.log("\n--- 测试 4: 主模型失败（AIGenerationError）→ 副模型成功 ---");

  const primary = new FailingProvider("openai-primary");
  const secondary = new SucceedingProvider("gemini/fallback");

  const fallback = new FallbackProvider(primary, secondary, "primary", "fallback");
  const result = await fallback.generateAlt(BASE_REQUEST);

  assertEqual(result.modelUsed, "gemini/fallback", "modelUsed 为副模型 gemini/fallback");
  assertTrue(result.altText.includes("gemini/fallback"), "altText 包含副模型名称");
}

// ============================================================================
// 测试 5: FallbackProvider — 主 + 副均失败 → 抛出 AIGenerationError
// ============================================================================

async function testBothProvidersFail(): Promise<void> {
  console.log("\n--- 测试 5: 主 + 副均失败 → 抛出 AIGenerationError ---");

  const primary = new FailingProvider("primary");
  const secondary = new FailingProvider("secondary");

  const fallback = new FallbackProvider(primary, secondary, "primary", "secondary");

  await assertThrows(
    () => fallback.generateAlt(BASE_REQUEST),
    AIGenerationError,
    "主副均失败时抛出 AIGenerationError",
  );
}

// ============================================================================
// 测试 6: FakeAIProvider — 不同 URL 返回不同确定性结果
// ============================================================================

async function testFakeAIProviderDifferentURLs(): Promise<void> {
  console.log("\n--- 测试 6: FakeAIProvider 不同 URL 返回不同 altText ---");

  const provider = new FakeAIProvider();

  const req1 = { ...BASE_REQUEST, imageUrl: "https://cdn.shopify.com/products/sneakers.jpg" };
  const req2 = { ...BASE_REQUEST, imageUrl: "https://cdn.shopify.com/products/hat.png" };

  const r1 = await provider.generateAlt(req1);
  const r2 = await provider.generateAlt(req2);

  assertEqual(r1.altText, "Fake alt for sneakers.jpg", "sneakers.jpg 的 altText 正确");
  assertEqual(r2.altText, "Fake alt for hat.png", "hat.png 的 altText 正确");
  assertTrue(r1.altText !== r2.altText, "不同 URL 返回不同 altText");
}

// ============================================================================
// 测试 7: FallbackProvider — 主模型成功时不调用副模型
// ============================================================================

async function testFallbackNotCalledWhenPrimarySucceeds(): Promise<void> {
  console.log("\n--- 测试 7: 主模型成功时副模型不被调用 ---");

  let secondaryCalled = false;
  const primary = new SucceedingProvider("gpt-4o");
  const secondary: AIProvider = {
    async generateAlt(_req: GenerateAltRequest): Promise<GenerateAltResult> {
      secondaryCalled = true;
      return { altText: "secondary", modelUsed: "secondary" };
    },
  };

  const fallback = new FallbackProvider(primary, secondary, "primary", "secondary");
  const result = await fallback.generateAlt(BASE_REQUEST);

  assertEqual(result.modelUsed, "gpt-4o", "modelUsed 为主模型");
  assertTrue(!secondaryCalled, "副模型未被调用");
}

// ============================================================================
// 运行所有测试
// ============================================================================

async function run(): Promise<void> {
  console.log("\n=== ai-gateway.test.ts ===");

  try {
    await testFakeAIProviderDeterministic();
    await testFakeAIProviderSimulatedFailure();
    await testFallbackOnPrimaryTimeout();
    await testFallbackOnPrimaryError();
    await testBothProvidersFail();
    await testFakeAIProviderDifferentURLs();
    await testFallbackNotCalledWhenPrimarySucceeds();
  } catch (err) {
    console.error("\n  ✗ 测试执行异常:", err);
    failed++;
  }

  console.log(`\n  总计: ${passed + failed} 项, 通过: ${passed}, 失败: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();