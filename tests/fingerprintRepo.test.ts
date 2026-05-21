import assert from "node:assert/strict";
import { ResourceImageFingerprintResourceType } from "@prisma/client";

async function run(): Promise<void> {
  const { get, upsert, compareAndDecide } = await import(
    "../server/modules/fingerprint/fingerprintRepo.js"
  );
  const { default: prisma } = await import("../server/db/prisma.server.js");

  const shopId = "cmnidcs270000rkttrzm1awme";
  const resourceType = ResourceImageFingerprintResourceType.PRODUCT;
  const resourceId = "gid://shopify/Product/42";

  try {
    /* ================================================================ */
    /*  1. get — 不存在返回 null                                        */
    /* ================================================================ */
    {
      const result = await get(shopId, resourceType, resourceId);
      assert.equal(result, null, "记录不存在时应返回 null");
    }

    /* ================================================================ */
    /*  2. upsert — 写入新记录                                          */
    /* ================================================================ */
    {
      await upsert(shopId, resourceType, resourceId, "abc123");
      const result = await get(shopId, resourceType, resourceId);
      assert.equal(result, "abc123", "写入后应能读取到指纹");
    }

    /* ================================================================ */
    /*  3. upsert — 覆盖已有记录                                        */
    /* ================================================================ */
    {
      await upsert(shopId, resourceType, resourceId, "def456");
      const result = await get(shopId, resourceType, resourceId);
      assert.equal(result, "def456", "重复写入应覆盖指纹");
    }

    /* ================================================================ */
    /*  4. compareAndDecide — 首次（无记录）→ CHANGED                    */
    /* ================================================================ */
    {
      const result = await compareAndDecide(
        shopId,
        resourceType,
        "never-seen-id",
        "anything",
      );
      assert.equal(result, "CHANGED", "无记录时应返回 CHANGED");
    }

    /* ================================================================ */
    /*  5. compareAndDecide — 相同 → UNCHANGED                          */
    /* ================================================================ */
    {
      const result = await compareAndDecide(
        shopId,
        resourceType,
        resourceId,
        "def456",
      );
      assert.equal(result, "UNCHANGED", "指纹相同时应返回 UNCHANGED");
    }

    /* ================================================================ */
    /*  6. compareAndDecide — 不同 → CHANGED                            */
    /* ================================================================ */
    {
      const result = await compareAndDecide(
        shopId,
        resourceType,
        resourceId,
        "xyz789",
      );
      assert.equal(result, "CHANGED", "指纹不同时应返回 CHANGED");
    }

    console.log("✅ fingerprintRepo 测试全部通过");
  } finally {
    await prisma.resourceImageFingerprint.deleteMany({
      where: {
        shopId,
        resourceId: { in: [resourceId, "never-seen-id"] },
      },
    });
    await prisma.$disconnect();
  }
}

void run().catch((error: unknown) => {
  console.error("❌ fingerprintRepo 测试失败");
  console.error(error);
  process.exit(1);
});
