/**
 * File: app/routes/api.scan.start.tsx
 * Purpose: POST /api/scan/start —— 扫描启动接口（首次扫描 + 重新扫描）。
 *          接收 scopeFlags + noticeVersion，完成：
 *          1. notice 确认写入（幂等）
 *          2. scope flags 更新
 *          3. scan lock 获取
 *          4. scan_job + scan_task 创建（事务）
 *          5. Redis 进度键初始化
 *          6. BullMQ 入队
 *
 * 请求体: { scopeFlags: ScopeFlagState, noticeVersion: string }
 * 响应体: { scanJobId: string, batchId: string, status: string }
 */
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ackNotice } from "../../server/modules/notice/scan-notice-ack.service";
import { updateScanScopeFlags } from "../../server/modules/shop/scope.service";
import { acquireLock, releaseLock } from "../../server/modules/lock/operation-lock.service";
import { createScanJobWithTasks } from "../../server/modules/scan/catalog/scan-job.service";
import { scopeFlagsToResourceTypes } from "../../server/modules/scan/scan.constants";
import { initScanProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";
import {
  scopeFlagStateSchema,
  listEnabledScopeFlags,
  type ScopeFlagState,
} from "../lib/scope-utils";
import { enqueueScanStart } from "../../server/queues/scan-start.queue";

const logger = createLogger({ module: "api.scan.start" });

/** 请求体 schema：scopeFlags 各字段 + noticeVersion */
const scanStartBodySchema = z.object({
  PRODUCT_MEDIA: z.boolean(),
  FILES: z.boolean(),
  COLLECTION_IMAGE: z.boolean(),
  ARTICLE_IMAGE: z.boolean(),
  noticeVersion: z.string().min(1),
});

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. 仅接受 POST
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // 2. 鉴权
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;

  // 3. 查找 shop
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  if (!shop) {
    logger.warn({ shopDomain }, "Shop not found for scan start");
    return Response.json({ error: "Shop not found" }, { status: 404 });
  }

  // 4. 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let parsed: z.infer<typeof scanStartBodySchema>;
  try {
    parsed = scanStartBodySchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
      return Response.json({ error: "Invalid request body", issues }, { status: 400 });
    }
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { noticeVersion, ...scopeFlagsRaw } = parsed;
  const scopeFlags: ScopeFlagState = {
    PRODUCT_MEDIA: scopeFlagsRaw.PRODUCT_MEDIA,
    FILES: scopeFlagsRaw.FILES,
    COLLECTION_IMAGE: scopeFlagsRaw.COLLECTION_IMAGE,
    ARTICLE_IMAGE: scopeFlagsRaw.ARTICLE_IMAGE,
  };

  // 5. 校验至少选择一个 scope
  const enabledFlags = listEnabledScopeFlags(scopeFlags);
  if (enabledFlags.length === 0) {
    return Response.json(
      { error: "At least one scope flag must be enabled" },
      { status: 400 },
    );
  }

  // 6. 将 ScopeFlag 转换为 ScanResourceType
  const enabledResourceTypes = scopeFlagsToResourceTypes(enabledFlags);

  // 7. 生成 lock owner（batchId 同时作为响应中的 batchId）
  const batchId = `scan-${shop.id}-${Date.now()}`;
  const lockOwner = { batchId };

  // 8. 尝试获取 scan 锁
  const lockResult = await acquireLock(shop.id, "SCAN", lockOwner);

  if (!lockResult.acquired) {
    logger.warn({ shopId: shop.id }, "Scan lock conflict");
    return Response.json(
      { error: "Another scan is already running. Please try again later." },
      { status: 409 },
    );
  }

  try {
    // 9. 写入 notice 确认（幂等）
    await ackNotice({
      shopId: shop.id,
      noticeKey: "SCAN_NOTICE",
      version: noticeVersion,
      scopeFlagsSnapshot: scopeFlags,
      actor: "SHOP_OWNER",
    });

    // 10. 更新 scope flags
    await updateScanScopeFlags(shop.id, scopeFlags);

    // 11. 在事务内创建 scan_job + scan_task
    const scanJobResult = await createScanJobWithTasks({
      shopId: shop.id,
      scopeFlags: scopeFlags as Record<string, boolean>,
      noticeVersion,
      enabledResourceTypes,
    });

    // 12. 初始化 Redis 进度键
    await initScanProgress(scanJobResult.scanJobId, enabledResourceTypes.length);

    // 13. 入队 BullMQ
    await enqueueScanStart({
      shopId: shop.id,
      scanJobId: scanJobResult.scanJobId,
      scopeFlags,
    });

    logger.info(
      {
        shopId: shop.id,
        scanJobId: scanJobResult.scanJobId,
        batchId,
        enabledFlags,
        taskCount: scanJobResult.tasks.length,
      },
      "Scan job created, progress initialized, and queued",
    );

    return Response.json({
      scanJobId: scanJobResult.scanJobId,
      batchId,
      status: scanJobResult.scanJobStatus,
    });
  } catch (err) {
    // 创建失败时释放锁
    logger.error({ shopId: shop.id, err }, "Failed to start scan");

    try {
      await releaseLock(shop.id, lockOwner);
    } catch {
      // 释放锁失败不影响错误返回
    }

    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
