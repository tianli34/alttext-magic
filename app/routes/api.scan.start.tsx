/**
 * File: app/routes/api.scan.start.tsx
 *          Purpose: POST /api/scan/start —— 扫描启动接口（首次扫描 + 重新扫描）。
 *          接收 scopeFlags + noticeVersion，完成：
 *          1. notice 确认写入（幂等）
 *          2. scope flags 更新
 *          3. WRITEBACK 锁互斥检查（Redis）
 *          4. scan lock 获取（PG）
 *          5. scan_job + scan_task 创建（事务）
 *          6. Redis 进度键初始化
 *          7. BullMQ 入队
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
import {
  acquireLock,
  releaseLock,
  releaseLockByType,
  hasRunningScanJob,
} from "../../server/modules/lock/operation-lock.service";
import { isWritebackLocked } from "../../server/modules/lock/writeback-lock.service";
import { createScanJobWithTasks } from "../../server/modules/scan/catalog/scan-job.service";
import { scopeFlagsToResourceTypes } from "../../server/modules/scan/scan.constants";
import { deleteScanProgress, initScanProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";
import {
  scopeFlagStateSchema,
  listEnabledScopeFlags,
  type ScopeFlagState,
} from "../lib/scope-utils";
import { enqueueScanStart } from "../../server/queues/scan-start.queue";

const logger = createLogger({ module: "api.scan.start" });

/** 请求体 schema：仅接受契约形态 { scopeFlags, noticeVersion } */
const scanStartBodySchema = z.object({
  scopeFlags: scopeFlagStateSchema,
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

  const { noticeVersion, scopeFlags } = parsed;

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

  // 7. 检查 WRITEBACK 锁是否存在（互斥）
  const writebackActive = await isWritebackLocked(shop.id);
  if (writebackActive) {
    logger.warn({ shopId: shop.id }, "Scan blocked by active writeback lock");
    return Response.json(
      { error: "A writeback is already running. Please try again later." },
      { status: 409 },
    );
  }

  // 8. 生成 lock owner（batchId 同时作为响应中的 batchId）
  const batchId = `scan-${shop.id}-${Date.now()}`;
  const lockOwner = { batchId };

  // 9. 尝试获取 scan 锁
  const lockResult = await acquireLock(shop.id, "SCAN", lockOwner);

  if (!lockResult.acquired) {
    logger.warn(
      { shopId: shop.id, conflictingLockType: lockResult.lock?.operationType },
      "Scan lock conflict",
    );
    const isGenerate = lockResult.lock?.operationType === "GENERATE";
    const isWriteback = lockResult.lock?.operationType === "WRITEBACK";
    const isScan = lockResult.lock?.operationType === "SCAN";

    if (isGenerate) {
      return Response.json(
        { error: "A generation is already running. Please try again later." },
        { status: 409 },
      );
    }
    if (isWriteback) {
      return Response.json(
        { error: "A writeback is already running. Please try again later." },
        { status: 409 },
      );
    }

    // SCAN 锁冲突：仅当确实还存在 RUNNING 的 scan_job（即 UI 正在展示扫描界面）
    // 时才提示“Another scan is already running”，否则视为残留锁并清理后继续。
    if (isScan) {
      const runningJobExists = await hasRunningScanJob(shop.id);
      if (runningJobExists) {
        return Response.json(
          { error: "Another scan is already running. Please try again later." },
          { status: 409 },
        );
      }

      // 残留锁清理：释放后继续原流程（下方锁获取将重新拿到锁并正常启动扫描）。
      logger.warn(
        { shopId: shop.id, batchId: lockResult.lock?.batchId },
        "Stale SCAN lock found without running scan_job; releasing before retry",
      );
      try {
        await releaseLockByType(shop.id, "SCAN");
      } catch (err) {
        logger.error({ shopId: shop.id, err }, "Failed to release stale SCAN lock");
      }

      const retry = await acquireLock(shop.id, "SCAN", lockOwner);
      if (!retry.acquired) {
        return Response.json(
          { error: "Another scan is already running. Please try again later." },
          { status: 409 },
        );
      }
    } else {
      // 未知锁类型：与 SCAN 同视为可清理的残留锁，避免误导用户。
      logger.warn(
        { shopId: shop.id, conflictingLockType: lockResult.lock?.operationType },
        "Unknown conflict lock type treated as stale; releasing before retry",
      );
      try {
        if (lockResult.lock?.operationType) {
          await releaseLockByType(
            shop.id,
            lockResult.lock.operationType as "SCAN" | "GENERATE" | "WRITEBACK",
          );
        }
      } catch (err) {
        logger.error({ shopId: shop.id, err }, "Failed to release unknown stale lock");
      }

      const retry = await acquireLock(shop.id, "SCAN", lockOwner);
      if (!retry.acquired) {
        return Response.json(
          { error: "Another scan is already running. Please try again later." },
          { status: 409 },
        );
      }
    }
  }

  // job 创建成功后若投递失败, 需在 catch 中将 job 收敛为 FAILED, 避免留下 RUNNING 孤儿
  let createdScanJobId: string | null = null;

  try {
    // 10. 写入 notice 确认（幂等）
    await ackNotice({
      shopId: shop.id,
      noticeKey: "SCAN_NOTICE",
      version: noticeVersion,
      scopeFlagsSnapshot: scopeFlags,
      actor: "SHOP_OWNER",
    });

    // 11. 更新 scope flags
    await updateScanScopeFlags(shop.id, scopeFlags);

    // 12. 在事务内创建 scan_job + scan_task
    const scanJobResult = await createScanJobWithTasks({
      shopId: shop.id,
      scopeFlags: scopeFlags as Record<string, boolean>,
      noticeVersion,
      enabledResourceTypes,
    });
    createdScanJobId = scanJobResult.scanJobId;

    // 13. 初始化 Redis 进度键
    await initScanProgress(scanJobResult.scanJobId);

    // 14. 入队 BullMQ
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

    // job 已落库但投递(进度初始化/入队)失败: 事务性收敛为 FAILED, 避免孤儿 RUNNING 等 10 分钟超时兜底
    if (createdScanJobId) {
      const scanJobIdToConverge = createdScanJobId;
      const failureReason =
        err instanceof Error ? err.message : "scan start delivery failed";

      try {
        await prisma.$transaction(async (tx) => {
          await tx.scanTask.updateMany({
            where: { scanJobId: scanJobIdToConverge, status: "PENDING" },
            data: {
              status: "FAILED",
              error: `[SCAN_DELIVERY_FAILED] ${failureReason}`,
              finishedAt: new Date(),
            },
          });
          await tx.scanJob.updateMany({
            where: { id: scanJobIdToConverge, status: "RUNNING" },
            data: {
              status: "FAILED",
              error: `[SCAN_DELIVERY_FAILED] ${failureReason}`,
              finishedAt: new Date(),
            },
          });
        });
        await deleteScanProgress(scanJobIdToConverge);
      } catch (convergeErr) {
        // 收敛失败仅记录日志, 仍交由超时巡检兜底
        logger.error(
          { shopId: shop.id, scanJobId: scanJobIdToConverge, err: convergeErr },
          "Failed to converge undelivered scan job to FAILED",
        );
      }
    }

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
