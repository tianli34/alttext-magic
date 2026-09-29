/**
 * File: tests/unit/writeback/audit-idempotency.test.ts
 * Purpose: 写回审计落库（markWritten → upsertWritebackAudit）幂等性回归测试。
 *
 * 覆盖缺陷：audit_log 原唯一约束 (shop_id, write_target_id, alt_candidate_id) 与
 *          审计 create 落库叠加，使同一候选的第二次写回必然唯一冲突；
 *          Shopify fileUpdate 是外部副作用、不随事务回滚，markWritten 却整体回滚，
 *          BullMQ 重试的真值复核读回自写 Alt，把成功写回误判为「商家已手动补 Alt」
 *          （批次 success=0、审计缺失、候选被置 RESOLVED）。
 *
 * 断言：
 *   1. 同批次同候选被重复执行时不再抛唯一冲突，仍正常落 WRITTEN/SUCCESS/success+1，
 *      同 idempotency_key 只保留一条审计，且 oldAltText 保留首次记录的写回前原值；
 *   2. 同一候选跨批次再次写回可追加第二条审计（追加式审计，同三元组允许多行）。
 *
 * 说明：prisma 为内存假实现，$transaction 直接把同一 store 交给回调且不模拟回滚——
 *      「回滚后的残留状态」由测试显式重置；写回链路涉及的 Shopify/env/SSE/指标/日志
 *      模块全部 mock，测试不触达外部依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AltCandidateStatus,
  AltPlane,
  JobBatchStatus,
  JobItemStatus,
} from '@prisma/client';
import type { Session } from '@shopify/shopify-api';
import type { PrismaClient } from '@prisma/client';
import type { WritebackJobData } from '../../../server/queues/writeback.queue';
import type { WritebackProcessorDependencies } from '../../../worker/processors/writeback.processor';

// ── 重依赖全部 mock：模块加载阶段不拉起 Prisma / Shopify / Redis / env 校验 ──
vi.mock('../../../server/utils/logger', () => {
  const noop = () => undefined;
  const fakeLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
    withContext: () => fakeLogger,
  };
  return { createLogger: () => fakeLogger };
});

vi.mock('../../../server/config/env', () => ({
  env: { WRITEBACK_CONCURRENCY: 1, WRITEBACK_TRUTH_DEBUG: false },
}));

vi.mock('../../../server/db/prisma.server', () => ({ default: {} }));

vi.mock('../../../server/shopify/offline-admin.server', () => ({
  getOfflineAdminByShopId: async () => ({ session: {} }),
}));

vi.mock('../../../server/modules/generation/truth-check.service', () => ({
  TruthCheckService: { checkCurrentAlt: async () => ({ isEmpty: true, currentAlt: null }) },
}));

vi.mock('../../../server/modules/lock/writeback-lock.service', () => ({
  releaseWritebackLock: async () => undefined,
}));

vi.mock('../../../server/modules/writeback/writeback-router', () => ({
  WritebackRouter: class {
    getExecutor() {
      return { execute: async () => ({ success: true }) };
    }
  },
}));

vi.mock('../../../server/sse/writeback-truth-debug.publisher', () => ({
  publishWritebackTruthDebug: async () => undefined,
}));

vi.mock('../../../shared/logger/metrics', () => ({ recordMetric: () => undefined }));

const { processWritebackJob } = await import(
  '../../../worker/processors/writeback.processor'
);

const SHOP_ID = 'shop_test';
const CANDIDATE_ID = 'cand_test';
const TARGET_ID = 'target_test';
const DRAFT_ID = 'draft_test';
const WRITE_TARGET_ID = 'gid://shopify/MediaImage/28931872686214';
const ALT_TEXT = '黄色长方形礼品卡，带有红色十字丝带和中央蝴蝶结装饰。';
const NOW = new Date('2026-09-28T21:06:36.000+08:00');

/** Prisma 唯一约束冲突（P2002）的测试替身 */
class P2002Error extends Error {
  readonly code = 'P2002';
  constructor() {
    super('Unique constraint failed');
  }
}

interface AuditRow {
  id: string;
  shopId: string;
  writeTargetId: string;
  altCandidateId: string;
  idempotencyKey: string;
  oldAltText: string | null;
  newAltText: string;
  writtenAt: Date;
}

interface CandidateRow {
  id: string;
  shopId: string;
  altTargetId: string;
  status: AltCandidateStatus;
  writtenAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  altTarget: { id: string; altPlane: AltPlane; writeTargetId: string };
  draft: { id: string; generatedText: string; editedText: null; modelUsed: string } | null;
}

interface BatchRow {
  id: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  status: JobBatchStatus;
}

/** 写回链路用到的 Prisma 子集的内存实现 */
function createFakeStore() {
  const candidate: CandidateRow = {
    id: CANDIDATE_ID,
    shopId: SHOP_ID,
    altTargetId: TARGET_ID,
    status: AltCandidateStatus.GENERATED,
    writtenAt: null,
    errorCode: null,
    errorMessage: null,
    altTarget: { id: TARGET_ID, altPlane: AltPlane.FILE_ALT, writeTargetId: WRITE_TARGET_ID },
    draft: { id: DRAFT_ID, generatedText: ALT_TEXT, editedText: null, modelUsed: 'gpt-test' },
  };

  const state = {
    candidate,
    jobItems: new Map<string, { status: JobItemStatus; error: string | null }>(),
    batches: new Map<string, BatchRow>(),
    audits: [] as AuditRow[],
    auditSeq: 0,
  };

  const itemKey = (batchId: string) => `${batchId}/${CANDIDATE_ID}`;

  const store = {
    state,

    $transaction: async (fn: (tx: unknown) => Promise<boolean>) => fn(store),

    altCandidate: {
      findFirst: async () => ({ ...state.candidate }),
      updateMany: async (args: {
        where: { id: string; shopId: string };
        data: {
          status?: AltCandidateStatus;
          writtenAt?: Date;
          errorCode?: string | null;
          errorMessage?: string | null;
        };
      }) => {
        if (args.where.id !== state.candidate.id || args.where.shopId !== SHOP_ID) {
          return { count: 0 };
        }
        Object.assign(state.candidate, args.data);
        return { count: 1 };
      },
    },

    altDraft: { update: async () => ({}) },

    altTarget: { update: async () => ({}) },

    jobItem: {
      updateMany: async (args: {
        where: {
          batchId: string;
          altCandidateId: string;
          status?: JobItemStatus | { in: JobItemStatus[] };
        };
        data: { status: JobItemStatus; error?: string | null };
      }) => {
        const item = state.jobItems.get(itemKey(args.where.batchId));
        if (!item) return { count: 0 };
        const wanted = args.where.status;
        const matched =
          wanted === undefined
            ? true
            : typeof wanted === 'string'
              ? item.status === wanted
              : wanted.in.includes(item.status);
        if (!matched) return { count: 0 };
        item.status = args.data.status;
        if ('error' in args.data) item.error = args.data.error ?? null;
        return { count: 1 };
      },
      findUnique: async (args: {
        where: { batchId_altCandidateId: { batchId: string } };
      }) => {
        const item = state.jobItems.get(itemKey(args.where.batchId_altCandidateId.batchId));
        return item ? { id: 'item_test', status: item.status } : null;
      },
    },

    jobBatch: {
      update: async (args: {
        where: { id: string };
        data: {
          success?: { increment: number };
          failed?: { increment: number };
          skipped?: { increment: number };
        };
      }) => {
        const batch = state.batches.get(args.where.id);
        if (!batch) throw new Error(`batch 不存在: ${args.where.id}`);
        batch.success += args.data.success?.increment ?? 0;
        batch.failed += args.data.failed?.increment ?? 0;
        batch.skipped += args.data.skipped?.increment ?? 0;
        return batch;
      },
      findUnique: async (args: { where: { id: string } }) => {
        const batch = state.batches.get(args.where.id);
        if (!batch) return null;
        return {
          total: batch.total,
          success: batch.success,
          failed: batch.failed,
          skipped: batch.skipped,
          status: batch.status,
        };
      },
      updateMany: async (args: {
        where: { id: string; status?: JobBatchStatus };
        data: { status: JobBatchStatus };
      }) => {
        const batch = state.batches.get(args.where.id);
        if (!batch || (args.where.status !== undefined && batch.status !== args.where.status)) {
          return { count: 0 };
        }
        batch.status = args.data.status;
        return { count: 1 };
      },
    },

    auditLog: {
      /** 唯一性只由 idempotency_key 判定（等价迁移后的库内约束） */
      upsert: async (args: {
        where: { idempotencyKey: string };
        create: Omit<AuditRow, 'id'>;
        update: Partial<AuditRow>;
      }) => {
        const existing = state.audits.find(
          (row) => row.idempotencyKey === args.where.idempotencyKey,
        );
        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }
        state.auditSeq += 1;
        const row: AuditRow = { id: `audit_${state.auditSeq}`, ...args.create };
        state.audits.push(row);
        return row;
      },
      updateMany: async (args: {
        where: { idempotencyKey: string };
        data: Partial<AuditRow>;
      }) => {
        const existing = state.audits.find(
          (row) => row.idempotencyKey === args.where.idempotencyKey,
        );
        if (!existing) return { count: 0 };
        Object.assign(existing, args.data);
        return { count: 1 };
      },
      create: async (args: { data: Omit<AuditRow, 'id'> }) => {
        if (state.audits.some((row) => row.idempotencyKey === args.data.idempotencyKey)) {
          throw new P2002Error();
        }
        state.auditSeq += 1;
        const row: AuditRow = { id: `audit_${state.auditSeq}`, ...args.data };
        state.audits.push(row);
        return row;
      },
    },
  };

  return store;
}

type FakeStore = ReturnType<typeof createFakeStore>;

function makeJobData(batchId: string): WritebackJobData {
  return {
    shopId: SHOP_ID,
    candidateId: CANDIDATE_ID,
    batchId,
    lockId: 'lock_test',
    altPlane: AltPlane.FILE_ALT,
    shopifyGid: WRITE_TARGET_ID,
    altText: ALT_TEXT,
  };
}

/** 在内存 store 上开一个 RUNNING 批次 + 待写回项（等价 startWriteback 的产物） */
function seedBatch(store: FakeStore, batchId: string): void {
  store.state.batches.set(batchId, {
    id: batchId,
    total: 1,
    success: 0,
    failed: 0,
    skipped: 0,
    status: JobBatchStatus.RUNNING,
  });
  store.state.jobItems.set(`${batchId}/${CANDIDATE_ID}`, {
    status: JobItemStatus.PENDING,
    error: null,
  });
}

function makeDeps(
  store: FakeStore,
  options: { currentAlt?: string | null; executorCalls?: string[] } = {},
): WritebackProcessorDependencies {
  const currentAlt = options.currentAlt ?? null;
  const executorCalls = options.executorCalls;

  return {
    prisma: store as unknown as PrismaClient,
    // currentAlt 为 null → 复核判定「线上仍缺失」，走写回分支；
    // 传入具体值 → 复核判定「已填充」，用于验证自写识别与真实手动补写的分流
    truthCheck: async () =>
      ({ isEmpty: currentAlt === null, currentAlt }) as Awaited<
        ReturnType<WritebackProcessorDependencies["truthCheck"]>
      >,
    getAdminSession: async () => ({}) as unknown as Session,
    getExecutor: () => ({
      execute: async () => {
        executorCalls?.push("executed");
        return { success: true };
      },
    }) as unknown as ReturnType<WritebackProcessorDependencies["getExecutor"]>,
    releaseLock: async () => undefined,
    now: () => new Date(NOW.getTime()),
  };
}

/** 复刻缺陷现场：markWritten 事务回滚后候选/项回到可重入状态，但审计行残留 */
function emulateRollback(store: FakeStore, batchId: string): void {
  store.state.candidate.status = AltCandidateStatus.GENERATED;
  store.state.candidate.writtenAt = null;
  const item = store.state.jobItems.get(`${batchId}/${CANDIDATE_ID}`);
  if (item) item.status = JobItemStatus.RUNNING;
  const batch = store.state.batches.get(batchId);
  if (batch) batch.success = 0;
}

// ============================================================================
// 用例
// ============================================================================

describe('写回审计落库幂等性', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore();
  });

  it('同批次同候选重复执行不再唯一冲突：仍落 WRITTEN 且只保留一条审计', async () => {
    const batchId = 'batch_retry';
    seedBatch(store, batchId);

    // attempt#1：完整成功，审计已落库
    await processWritebackJob(makeJobData(batchId), makeDeps(store));
    expect(store.state.candidate.status).toBe(AltCandidateStatus.WRITTEN);
    expect(store.state.audits).toHaveLength(1);
    expect(store.state.audits[0]?.oldAltText).toBeNull();

    emulateRollback(store, batchId);

    // attempt#2：不得再抛 P2002，必须幂等收尾
    await processWritebackJob(makeJobData(batchId), makeDeps(store));

    expect(store.state.candidate.status).toBe(AltCandidateStatus.WRITTEN);
    expect(store.state.candidate.writtenAt).toEqual(NOW);
    expect(store.state.jobItems.get(`${batchId}/${CANDIDATE_ID}`)?.status).toBe(
      JobItemStatus.SUCCESS,
    );
    expect(store.state.batches.get(batchId)?.success).toBe(1);
    expect(store.state.batches.get(batchId)?.status).not.toBe(JobBatchStatus.FAILED);

    // 同 idempotency_key 只保留一条审计，且写回前原值不被重试轮覆盖
    expect(store.state.audits).toHaveLength(1);
    expect(store.state.audits[0]?.idempotencyKey).toBe(`writeback:${batchId}:${CANDIDATE_ID}`);
    expect(store.state.audits[0]?.oldAltText).toBeNull();
    expect(store.state.audits[0]?.newAltText).toBe(ALT_TEXT);
  });

  it('同一候选跨批次再次写回：审计按写回事件追加为两行', async () => {
    seedBatch(store, 'batch_first');
    await processWritebackJob(makeJobData('batch_first'), makeDeps(store));

    // 商家清空 Alt → 重扫：候选行复用，状态回到可写回
    store.state.candidate.status = AltCandidateStatus.GENERATED;
    store.state.candidate.writtenAt = null;
    seedBatch(store, 'batch_second');

    await processWritebackJob(makeJobData('batch_second'), makeDeps(store));

    const sameTupleRows = store.state.audits.filter(
      (row) =>
        row.shopId === SHOP_ID &&
        row.writeTargetId === WRITE_TARGET_ID &&
        row.altCandidateId === CANDIDATE_ID,
    );
    expect(sameTupleRows).toHaveLength(2);
    expect(new Set(sameTupleRows.map((row) => row.idempotencyKey)).size).toBe(2);
  });

  it('复核读回与待写文本一致（本应用自写）时按写回成功收尾，不判为商家手动补写', async () => {
    const batchId = 'batch_self_written';
    seedBatch(store, batchId);
    const executorCalls: string[] = [];

    await processWritebackJob(
      makeJobData(batchId),
      makeDeps(store, { currentAlt: ALT_TEXT, executorCalls }),
    );

    // 线上已是目标文本 → 不得再打一次 Shopify mutation
    expect(executorCalls).toHaveLength(0);
    expect(store.state.candidate.status).toBe(AltCandidateStatus.WRITTEN);
    expect(store.state.jobItems.get(`${batchId}/${CANDIDATE_ID}`)?.status).toBe(
      JobItemStatus.SUCCESS,
    );
    expect(store.state.batches.get(batchId)?.success).toBe(1);
    expect(store.state.batches.get(batchId)?.skipped).toBe(0);
    expect(store.state.audits).toHaveLength(1);
  });

  it('线上是他人撰写的不同文本时仍按已填充跳过（不误改为写回成功）', async () => {
    const batchId = 'batch_manual_alt';
    seedBatch(store, batchId);
    const executorCalls: string[] = [];

    await processWritebackJob(
      makeJobData(batchId),
      makeDeps(store, { currentAlt: '商家自己写的 Alt', executorCalls }),
    );

    expect(executorCalls).toHaveLength(0);
    expect(store.state.candidate.status).toBe(AltCandidateStatus.RESOLVED);
    expect(store.state.jobItems.get(`${batchId}/${CANDIDATE_ID}`)?.status).toBe(
      JobItemStatus.SKIPPED_ALREADY_FILLED,
    );
    expect(store.state.batches.get(batchId)?.success).toBe(0);
    expect(store.state.batches.get(batchId)?.skipped).toBe(1);
    expect(store.state.audits).toHaveLength(0);
  });
});


