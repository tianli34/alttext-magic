/**
 * File: app/routes/api.generation.start.tsx
 * Purpose: POST /api/generation/start —— 生成启动接口。
 *          获取 GENERATE 锁。如果已存在 SCAN 或 GENERATE 锁，则返回 409。
 */
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { acquireGenerateLock, releaseGenerateLock } from "../../server/modules/lock/generate-lock.service";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.generation.start" });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for generation start");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  const batchId = `gen-${shop.id}-${Date.now()}`;

  const lockResult = await acquireGenerateLock(shop.id, batchId);

  if (!lockResult.acquired) {
    logger.warn(
      { shopId: shop.id, conflictingLockType: lockResult.lock?.operationType },
      "Generation lock conflict",
    );
    const isScan = lockResult.lock?.operationType === "SCAN";
    const msg = isScan
      ? "A scan is currently running. Please try again later."
      : "Another generation is already running. Please try again later.";
    return Response.json({ error: msg }, { status: 409 });
  }

  try {
    // 假设后续会创建 generation batch 和 queue job 等逻辑
    // 这里仅做占位符
    logger.info({ shopId: shop.id, batchId }, "Generation started and lock acquired");

    return Response.json({
      batchId,
      status: "RUNNING",
    });
  } catch (err) {
    logger.error({ shopId: shop.id, err }, "Failed to start generation");

    try {
      await releaseGenerateLock(shop.id, batchId);
    } catch {
      // 忽略释放失败
    }

    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
