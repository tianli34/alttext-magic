/**
 * File: server/modules/billing/credit/grant-credit.server.ts
 * Purpose: 统一的额度发放服务 —— 所有 credit_bucket 创建必须通过本服务完成。
 *          在同一 Prisma 事务内完成 bucket 创建 + GRANT ledger 写入，
 *          并通过唯一约束实现幂等：重复调用仅返回已存在的 bucket，不产生重复数据。
 */

import { Prisma, type PrismaClient, type CreditBucket, type CreditLedger } from '@prisma/client';

import { createLogger } from '../../../utils/logger.js';
import type { CreditBucketType } from '../billing.types';

// ----------------------------------------------------------------------------
// Logger
// ----------------------------------------------------------------------------

const log = createLogger({ module: 'grant-credit' });

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

/** 额度发放入参 */
export interface GrantCreditBucketParams {
  /** 所属店铺 ID */
  shopId: string;
  /** 额度桶类型 */
  bucketType: CreditBucketType;
  /** 发放额度数量（必须 > 0） */
  amount: number;
  /** 周期标识，与 shopId + bucketType 组成唯一键 */
  cycleKey: string;
  /** 生效时间，默认 now() */
  effectiveAt?: Date;
  /** 过期时间（可选） */
  expiresAt?: Date | null;
  /** 关联订阅 ID（可选） */
  billingSubscriptionId?: string | null;
  /** 关联超额包 ID（可选） */
  overagePackPurchaseId?: string | null;
  /** 来源标识（写入 metadata，如 "subscription"、"welcome"） */
  source?: string;
  /** 来源引用（写入 metadata，如订阅 ID / 超额包 ID） */
  sourceRef?: string;
  /** Ledger reason 字段 */
  reason?: string;
  /** Ledger 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** 额度发放结果 */
export interface GrantCreditBucketResult {
  /** 涉及的额度桶（新建或已存在的） */
  bucket: CreditBucket;
  /** GRANT ledger 记录；若 bucket 已存在（幂等）则为 null */
  ledger: CreditLedger | null;
  /** 本次调用是否实际创建了新 bucket */
  created: boolean;
}

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

/** Prisma 唯一约束冲突错误码 */
const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

// ----------------------------------------------------------------------------
// 核心实现
// ----------------------------------------------------------------------------

/**
 * 发放一个 credit_bucket 并在同一事务中写入 GRANT ledger。
 *
 * ### 幂等保证
 * - `credit_bucket` 表存在 `@@unique([shopId, bucketType, cycleKey])`。
 * - 当唯一约束冲突时，不重复创建 bucket，直接返回已存在的记录。
 * - GRANT ledger 的 idempotencyKey 由 `{shopId}:{bucketType}:{cycleKey}:GRANT` 确定，
 *   确保同一 bucket 只有一条 GRANT 记录。
 *
 * ### 事务保证
 * - bucket 创建 + ledger 写入在同一个 Prisma interactive transaction 中完成。
 * - 发放失败不会产生半完成数据（全部回滚）。
 *
 * @param params  发放参数
 * @param client  可选 PrismaClient 实例（默认使用全局单例，方便测试注入）
 */
export async function grantCreditBucket(
  params: GrantCreditBucketParams,
  client?: PrismaClient,
): Promise<GrantCreditBucketResult> {
  const {
    shopId,
    bucketType,
    amount,
    cycleKey,
    effectiveAt,
    expiresAt,
    billingSubscriptionId,
    overagePackPurchaseId,
    source,
    sourceRef,
    reason,
    metadata,
  } = params;

  // ---- 参数校验 ----
  if (!shopId) {
    throw new Error('[grant-credit] shopId 不能为空');
  }
  if (!bucketType) {
    throw new Error('[grant-credit] bucketType 不能为空');
  }
  if (!cycleKey) {
    throw new Error('[grant-credit] cycleKey 不能为空');
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error(`[grant-credit] amount 必须为正整数，当前: ${amount}`);
  }

  // ---- 懒加载全局 Prisma 单例（避免顶层 import 循环 & 测试注入） ----
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 运行时保护
  const db = client ?? (await import('../../../db/prisma.server.js')).default;

  // ---- 构造确定性 idempotencyKey ----
  const ledgerIdempotencyKey = `${shopId}:${bucketType}:${cycleKey}:GRANT`;

  // ---- 合并 metadata ----
  const mergedMetadata: Record<string, unknown> = {
    ...(metadata ?? {}),
  };
  if (source) mergedMetadata.source = source;
  if (sourceRef) mergedMetadata.sourceRef = sourceRef;

  const now = new Date();
  const effectiveDate = effectiveAt ?? now;

  log.info(
    { shopId, bucketType, cycleKey, amount },
    '开始发放额度桶',
  );

  try {
    // ---- 交互式事务：bucket 创建 + ledger 写入 ----
    const result = await db.$transaction(async (tx) => {
      // 1. 尝试查找已存在的 bucket
      const existing = await tx.creditBucket.findUnique({
        where: {
          shopId_bucketType_cycleKey: {
            shopId,
            bucketType,
            cycleKey,
          },
        },
      });

      if (existing) {
        log.info(
          { shopId, bucketType, cycleKey, bucketId: existing.id },
          '额度桶已存在，跳过创建（幂等）',
        );
        return { bucket: existing, ledger: null as CreditLedger | null, created: false };
      }

      // 2. 创建 bucket（status = ACTIVE，remainingAmount = amount）
      const bucket = await tx.creditBucket.create({
        data: {
          shopId,
          bucketType,
          cycleKey,
          grantedAmount: amount,
          remainingAmount: amount,
          reservedAmount: 0,
          consumedAmount: 0,
          status: 'ACTIVE',
          effectiveAt: effectiveDate,
          expiresAt: expiresAt ?? null,
          activatedAt: now,
          billingSubscriptionId: billingSubscriptionId ?? null,
          overagePackPurchaseId: overagePackPurchaseId ?? null,
        },
      });

      // 3. 写入 GRANT ledger
      const ledger = await tx.creditLedger.create({
        data: {
          shopId,
          bucketId: bucket.id,
          type: 'GRANT',
          deltaAmount: amount,
          balanceAfter: amount,
          reason: reason ?? `${bucketType} 额度发放`,
          metadata: mergedMetadata as Prisma.InputJsonValue,
          idempotencyKey: ledgerIdempotencyKey,
          eventAt: now,
        },
      });

      log.info(
        { shopId, bucketType, cycleKey, bucketId: bucket.id, amount },
        '额度桶创建成功',
      );

      return { bucket, ledger, created: true };
    });

    return result;
  } catch (error: unknown) {
    // 处理并发场景下的唯一约束冲突
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      log.info(
        { shopId, bucketType, cycleKey },
        '并发冲突，查询已存在的额度桶',
      );

      // 冲突发生在 bucket 或 ledger 的唯一约束 —— 查找已存在的记录
      const existingBucket = await db.creditBucket.findUnique({
        where: {
          shopId_bucketType_cycleKey: {
            shopId,
            bucketType,
            cycleKey,
          },
        },
      });

      if (existingBucket) {
        // 查找对应的 GRANT ledger（可能已被并发事务写入）
        const existingLedger = await db.creditLedger.findUnique({
          where: { idempotencyKey: ledgerIdempotencyKey },
        });

        log.info(
          { shopId, bucketType, cycleKey, bucketId: existingBucket.id },
          '返回已存在的额度桶（并发幂等）',
        );

        return {
          bucket: existingBucket,
          ledger: existingLedger,
          created: false,
        };
      }

      // 理论上不应到达此处（唯一约束冲突但找不到记录）
      log.error(
        { shopId, bucketType, cycleKey, error },
        '唯一约束冲突但未找到已存在记录，异常状态',
      );
      throw new Error(
        `[grant-credit] 唯一约束冲突但未找到已存在记录: ${shopId}/${bucketType}/${cycleKey}`,
      );
    }

    // 非约束错误，向上抛出
    log.error(
      { shopId, bucketType, cycleKey, error },
      '额度发放失败',
    );
    throw error;
  }
}
