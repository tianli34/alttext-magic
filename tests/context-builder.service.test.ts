/**
 * File: tests/context-builder.service.test.ts
 * Purpose: ContextBuilderService 单元测试。
 * 运行: npx tsx tests/context-builder.service.test.ts
 */

import { AltPlane, ImageUsageType, PresentStatus, AltDraftContextMode } from "@prisma/client";
import { ContextBuilderService } from "../server/modules/generation/context-builder.service.js";
import prisma from "../server/db/prisma.server.js";

// ============================================================
// 测试框架工具
// ============================================================

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.error(`    ✗ ${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ── Mock prisma ──────────────────────────────────────────────
const originalFindUniqueOrThrow = prisma.altTarget.findUniqueOrThrow;
const originalFindMany = prisma.imageUsage.findMany;

let mockAltTarget: any = null;
let mockImageUsages: any[] = [];

function setupTest(target: any, usages: any[]) {
  mockAltTarget = target;
  mockImageUsages = usages;

  (prisma.altTarget.findUniqueOrThrow as any) = async () => mockAltTarget;
  (prisma.imageUsage.findMany as any) = async () => mockImageUsages;
}

function teardownTest() {
  (prisma.altTarget.findUniqueOrThrow as any) = originalFindUniqueOrThrow;
  (prisma.imageUsage.findMany as any) = originalFindMany;
}

// ============================================================
// 测试用例
// ============================================================

async function testSingleProductUsage() {
  console.log("\n--- 测试: 单引用产品图 → RESOURCE_SPECIFIC ---");
  setupTest(
    {
      id: "target_1",
      altPlane: AltPlane.FILE_ALT,
      previewUrl: "https://example.com/shoes.png",
      displayTitle: "SHOES",
      displayHandle: "shoes",
    },
    [
      {
        usageType: ImageUsageType.PRODUCT,
        presentStatus: PresentStatus.PRESENT,
        title: "Nike Shoes",
        handle: "nike-shoes",
      },
    ]
  );

  try {
    const result = await ContextBuilderService.buildContext({ altTargetId: "target_1" });
    assertEqual(result.contextMode, AltDraftContextMode.RESOURCE_SPECIFIC, "contextMode 为 RESOURCE_SPECIFIC");
    assertEqual(result.contextSnapshot.resourceTitle, "Nike Shoes", "snapshot 包含产品标题");
    assertEqual(result.contextSnapshot.filename, "shoes.png", "snapshot 包含 filename");
  } finally {
    teardownTest();
  }
}

async function testPureFileUsage() {
  console.log("\n--- 测试: 纯文件库图 → FILE_NEUTRAL ---");
  setupTest(
    {
      id: "target_2",
      altPlane: AltPlane.FILE_ALT,
      previewUrl: "https://example.com/bg.png",
    },
    [
      {
        usageType: ImageUsageType.FILE,
        presentStatus: PresentStatus.PRESENT,
        title: null,
        handle: null,
      },
    ]
  );

  try {
    const result = await ContextBuilderService.buildContext({ altTargetId: "target_2" });
    assertEqual(result.contextMode, AltDraftContextMode.FILE_NEUTRAL, "contextMode 为 FILE_NEUTRAL");
    assertEqual(Object.keys(result.contextSnapshot).includes("filename"), true, "snapshot 仅含/包含文件名");
    assertEqual(result.contextSnapshot.filename, "bg.png", "filename 解析正确");
    assertEqual(result.contextSnapshot.resourceTitle, undefined, "无资源标题");
  } finally {
    teardownTest();
  }
}

async function testSharedUsages() {
  console.log("\n--- 测试: 被 3 个产品共享的图 → SHARED_NEUTRAL ---");
  setupTest(
    {
      id: "target_3",
      altPlane: AltPlane.FILE_ALT,
      previewUrl: "https://example.com/shared.png",
    },
    [
      { usageType: ImageUsageType.PRODUCT, presentStatus: PresentStatus.PRESENT, title: "P1", handle: "p1" },
      { usageType: ImageUsageType.PRODUCT, presentStatus: PresentStatus.PRESENT, title: "P2", handle: "p2" },
      { usageType: ImageUsageType.PRODUCT, presentStatus: PresentStatus.PRESENT, title: "P3", handle: "p3" },
    ]
  );

  try {
    const result = await ContextBuilderService.buildContext({ altTargetId: "target_3" });
    assertEqual(result.contextMode, AltDraftContextMode.SHARED_NEUTRAL, "contextMode 为 SHARED_NEUTRAL");
    assertEqual(result.contextSnapshot.usageCount, 3, "snapshot 含 usageCount=3");
    assertEqual(result.contextSnapshot.resourceTitle, undefined, "无资源标题");
    assertEqual(result.contextSnapshot.usageTypes.includes(ImageUsageType.PRODUCT), true, "usageTypes 包含 PRODUCT");
  } finally {
    teardownTest();
  }
}

async function testBoundaryTransition() {
  console.log("\n--- 测试: 边界：引用数量从 1 变为 2 后判定正确切换 ---");
  // 模拟从 1 个产品变为 2 个产品
  setupTest(
    {
      id: "target_4",
      altPlane: AltPlane.FILE_ALT,
      previewUrl: "https://example.com/item.png",
    },
    [
      { usageType: ImageUsageType.PRODUCT, presentStatus: PresentStatus.PRESENT, title: "A", handle: "a" },
      { usageType: ImageUsageType.PRODUCT, presentStatus: PresentStatus.PRESENT, title: "B", handle: "b" },
    ]
  );

  try {
    const result = await ContextBuilderService.buildContext({ altTargetId: "target_4" });
    assertEqual(result.contextMode, AltDraftContextMode.SHARED_NEUTRAL, "contextMode 为 SHARED_NEUTRAL (2个产品)");
    assertEqual(result.contextSnapshot.usageCount, 2, "snapshot 变为 usageCount=2");
  } finally {
    teardownTest();
  }
}

async function testCollectionSpecific() {
  console.log("\n--- 测试: 集合图 → RESOURCE_SPECIFIC ---");
  setupTest(
    {
      id: "target_5",
      altPlane: AltPlane.COLLECTION_IMAGE_ALT,
      previewUrl: "https://example.com/collection.png",
      displayTitle: "Summer Sale",
      displayHandle: "summer-sale",
    },
    []
  );

  try {
    const result = await ContextBuilderService.buildContext({ altTargetId: "target_5" });
    assertEqual(result.contextMode, AltDraftContextMode.RESOURCE_SPECIFIC, "contextMode 为 RESOURCE_SPECIFIC");
    assertEqual(result.contextSnapshot.resourceType, "COLLECTION", "resourceType 为 COLLECTION");
    assertEqual(result.contextSnapshot.resourceTitle, "Summer Sale", "标题正确");
  } finally {
    teardownTest();
  }
}

// ============================================================
// 运行所有测试
// ============================================================

async function run() {
  console.log("\n=== context-builder.service.test.ts ===");
  try {
    await testSingleProductUsage();
    await testPureFileUsage();
    await testSharedUsages();
    await testBoundaryTransition();
    await testCollectionSpecific();
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
