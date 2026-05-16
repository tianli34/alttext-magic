/**
 * File: app/routes/api.generation.start.tsx
 * Purpose: POST /api/generation/start —— 生成启动接口。
 *          创建 batch、预留额度、获取 GENERATE 锁并投递 generate_alt jobs。
 */
import { AltCandidateStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createReservation, releaseReservation } from "../services/credits/credit-reservation.server";
import { acquireGenerateLock, releaseGenerateLock } from "../../server/modules/lock/generate-lock.service";
import { GenerationBatchService } from "../../server/modules/generation/generation-batch.service";
import { enqueueGenerateAltJob } from "../../server/queues/generate-alt.queue";
import { initGenerationProgress } from "../../server/sse/progress-publisher";
import { createLogger } from "../../server/utils/logger";

const logger = createLogger({ module: "api.generation.start" });

const startBodySchema = z.object({
  candidateIds: z.array(z.string().min(1)).min(1),
});

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

  let parsed: z.infer<typeof startBodySchema>;
  try {
    parsed = startBodySchema.parse(await request.json());
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        {
          error: "Invalid request body",
          issues: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const candidateIds = Array.from(new Set(parsed.candidateIds));
  if (candidateIds.length !== parsed.candidateIds.length) {
    return Response.json(
      { error: "candidateIds must be unique" },
      { status: 400 },
    );
  }

  const { batch } = await GenerationBatchService.createBatch(shop.id, candidateIds);
  const batchId = batch.id;

  const lockResult = await acquireGenerateLock(shop.id, batchId);

  if (!lockResult.acquired) {
    await prisma.generationBatch.update({
      where: { id: batchId },
      data: { status: "FAILED" },
    });
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
    const candidates = await prisma.altCandidate.findMany({
      where: {
        id: { in: candidateIds },
        shopId: shop.id,
        status: AltCandidateStatus.MISSING,
      },
      include: { altTarget: true },
    });

    if (candidates.length !== candidateIds.length) {
      throw new Error("[api.generation.start] 部分 candidate 不存在或不可生成");
    }

    const candidatesWithoutImage = candidates.filter((candidate) => !candidate.altTarget.previewUrl);
    if (candidatesWithoutImage.length > 0) {
      throw new Error("[api.generation.start] 部分 candidate 缺少 previewUrl");
    }

    const reservationResult = await createReservation({
      shopId: shop.id,
      batchId,
      amount: candidates.length,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await initGenerationProgress(batchId, candidates.length);

    for (const candidate of candidates) {
      await enqueueGenerateAltJob({
        batchId,
        candidateId: candidate.id,
        shopId: shop.id,
        shopifyImageId: candidate.altTarget.writeTargetId,
        altPlane: candidate.altTarget.altPlane,
        imageUrl: candidate.altTarget.previewUrl!,
      });
    }

    logger.info(
      {
        shopId: shop.id,
        batchId,
        totalCount: candidates.length,
        reservationId: reservationResult.reservation.id,
      },
      "Generation started",
    );

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
    try {
      const reservation = await prisma.creditReservation.findUnique({
        where: { shopId_batchId: { shopId: shop.id, batchId } },
        select: { id: true, status: true },
      });
      if (reservation?.status === "ACTIVE") {
        await releaseReservation({
          shopId: shop.id,
          reservationId: reservation.id,
          reason: "GENERATION_START_FAILED",
        });
      }
    } catch {
      // 忽略兜底释放失败，reservation-reaper 会继续处理过期预留
    }
    await prisma.generationBatch.update({
      where: { id: batchId },
      data: { status: "FAILED" },
    });

    return Response.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
};
