/**
 * File: server/modules/scan/catalog/scan-job.service.ts
 * Purpose: scan_job 创建服务。
 *          在单个 Prisma 事务内完成 scan_job + scan_task 的原子创建。
 */
import type { PrismaClient, ScanResourceType } from "@prisma/client";
import prisma from "../../../db/prisma.server";
import { createLogger } from "../../../utils/logger";
import type { CreateScanJobParams, CreateScanJobResult, ScanTaskCreateInfo } from "../scan.types";

const logger = createLogger({ module: "scan-job-service" });

type TransactionClient = Parameters<PrismaClient["$transaction"]>[0] extends (
  tx: infer T,
) => Promise<unknown>
  ? T
  : never;

/**
 * 在单个事务内创建 scan_job 和按 scope 对应的 scan_task。
 *
 * 事务保证：
 * - scan_job 和 scan_task 原子写入
 * - scan_task 通过 @@unique([scanJobId, resourceType]) 约束避免重复
 *
 * @param params 创建参数，包含 shopId、scopeFlags、noticeVersion、enabledResourceTypes
 * @returns 创建结果，包含 scanJobId、status 和 tasks 列表
 */
export async function createScanJobWithTasks(
  params: CreateScanJobParams,
): Promise<CreateScanJobResult> {
  const { shopId, scopeFlags, noticeVersion, enabledResourceTypes } = params;

  return prisma.$transaction(async (tx: TransactionClient) => {
    // 1. 创建 scan_job
    const scanJob = await tx.scanJob.create({
      data: {
        shopId,
        scopeFlags: scopeFlags as Record<string, boolean>,
        noticeVersion,
        status: "RUNNING",
        publishStatus: "PENDING",
      },
      select: { id: true, status: true },
    });

    // 2. 按 enabledResourceTypes 创建 scan_task
    const tasks: ScanTaskCreateInfo[] = await Promise.all(
      enabledResourceTypes.map((resourceType: ScanResourceType) =>
        tx.scanTask
          .create({
            data: {
              shopId,
              scanJobId: scanJob.id,
              resourceType,
              status: "PENDING",
            },
            select: { id: true, resourceType: true },
          })
          .then((t) => ({ id: t.id, resourceType: t.resourceType })),
      ),
    );

    logger.info(
      {
        shopId,
        scanJobId: scanJob.id,
        taskCount: tasks.length,
        resourceTypes: enabledResourceTypes,
      },
      "scan_job + scan_tasks created in transaction",
    );

    return {
      scanJobId: scanJob.id,
      scanJobStatus: scanJob.status,
      tasks,
    };
  });
}
