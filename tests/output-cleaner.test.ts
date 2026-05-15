/**
 * File: tests/output-cleaner.test.ts
 * 验收标准：
 *   1. trim / 去除引号
 *   2. 去除 "image of" / "photo of" 等开头 (不区分大小写)
 *   3. 智能截断至 125 字符 (在单词边界截断并加 ...)
 *   4. 空值抛错
 * 
 * 运行：npx tsx tests/output-cleaner.test.ts
 */

import { cleanAltText } from "../server/ai/output-cleaner.server.js";

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(`    ✗ ${label}: 期望 ${JSON.stringify(expected)}, 实际得到 ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => unknown, label: string): void {
  try {
    fn();
    failed++;
    console.error(`    ✗ ${label}: 期望抛出错误，但没有抛出`);
  } catch (err) {
    passed++;
    console.log(`    ✓ ${label} (捕获到期望的错误: ${(err as Error).message})`);
  }
}

// ============================================================================
// 测试用例
// ============================================================================

function testBasicCleaning() {
  console.log("\n--- 测试 1: 基础清洗 (Trim & Quotes) ---");
  assertEqual(cleanAltText("  hello world  "), "Hello world", "基础 trim 和首字母大写");
  assertEqual(cleanAltText('"A stylish blue sneaker"'), "A stylish blue sneaker", "去除双引号");
  assertEqual(cleanAltText("'A red leather bag'"), "A red leather bag", "去除单引号");
}

function testPrefixRemoval() {
  console.log("\n--- 测试 2: 去除冗余前缀 ---");
  assertEqual(cleanAltText("image of a sunset over the mountains"), "A sunset over the mountains", "去除 image of");
  assertEqual(cleanAltText("PHOTO OF A CUTE CAT"), "A cute cat", "去除 PHOTO OF 并处理全大写");
  assertEqual(cleanAltText("picture of a modern kitchen"), "A modern kitchen", "去除 picture of");
  assertEqual(cleanAltText("a photo of a beautiful garden"), "A beautiful garden", "去除 a photo of");
}

function testTruncation() {
  console.log("\n--- 测试 3: 智能截断 ---");
  
  // 构造一个长文本
  // "This is a very long description that exceeds the limit of one hundred and twenty-five characters and should be truncated at a word boundary."
  const longText = "This is a very long description that exceeds the limit of one hundred and twenty-five characters and should be truncated at a word boundary correctly.";
  const result = cleanAltText(longText);
  
  console.log(`    结果长度: ${result.length}`);
  assertEqual(result.length <= 125, true, "长度不超过 125");
  assertEqual(result.endsWith("..."), true, "以 ... 结尾");
  assertEqual(result.includes("correctly"), false, "超出的部分被截断了");
  
  // 检查截断位置是否在单词边界
  const expectedEnd = "This is a very long description that exceeds the limit of one hundred and twenty-five characters and should be truncated...";
  assertEqual(result, expectedEnd, "在单词边界处截断");
}

function testEmptyAndError() {
  console.log("\n--- 测试 4: 边界情况 (空值) ---");
  assertThrows(() => cleanAltText(""), "空字符串抛错");
  assertThrows(() => cleanAltText("   "), "仅空格抛错");
  assertThrows(() => cleanAltText("image of  "), "前缀去除后变为空抛错");
}

// ============================================================================
// 运行
// ============================================================================

function run() {
  console.log("\n=== output-cleaner.test.ts ===");
  try {
    testBasicCleaning();
    testPrefixRemoval();
    testTruncation();
    testEmptyAndError();
  } catch (err) {
    console.error("\n  ✗ 测试执行中发生意外:", err);
    failed++;
  }

  console.log(`\n  总计: ${passed + failed} 项, 通过: ${passed}, 失败: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
