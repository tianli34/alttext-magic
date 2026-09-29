/**
 * File: tests/unit/generation/generation-progress.test.ts
 * Purpose: 生成进度轮询兜底数据源的单元测试。
 *          背景：生成进度此前只有 SSE 一条通道，SSE 响应体被隧道/代理整体缓冲时
 *          前端全程显示「0 / N 已完成」；修复方式是新增轮询接口读取同口径快照。
 *          本测试覆盖该数据源的关键行为：
 *          1. 快照计数与 generation_batch 完全同口径（IN_PROGRESS 期间即反映增量）
 *          2. 批次不存在 / 跨店铺访问一律返回 null（防越权探测他店批次）
 *          3. 终态快照透传 writebackBatchId / writebackError（供前端接写回进度）
 *          4. 非终态不做 settle 等待（只读一次 Redis，不阻塞轮询请求）
 *          5. readAutoWritebackLink 的 settle 语义：字段缺失时有限重试，
 *             显式空串视为「确定无需写回」立即返回
 *
 *          Prisma 单例、Redis 连接、logger 全部 mock，测试不触达外部依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  hmget: vi.fn(),
}));

vi.mock('../../../server/db/prisma.server', () => ({
  default: {
    generationBatch: {
      findUnique: (args: unknown) => mocks.findUnique(args),
    },
  },
}));

vi.mock('../../../server/queues/connection', () => ({
  queueConnection: {
    hmget: (key: string, ...fields: string[]) => mocks.hmget(key, ...fields),
  },
}));

// 日志器替换：避免测试输出 pino 噪音
vi.mock('../../../server/utils/logger', () => {
  const noop = () => undefined;
  const fakeLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    trace: noop,
  };
  return { createLogger: () => fakeLogger };
});

const { getGenerationProgressSnapshot } = await import(
  '../../../server/modules/generation/generation-progress.service'
);
const { readAutoWritebackLink } = await import(
  '../../../server/sse/progress-publisher'
);

// ============================================================================
// 测试辅助
// ============================================================================

const SHOP_ID = 'shop_progress_test';
const BATCH_ID = 'gbatch_progress_test';
const PROGRESS_KEY = `generation:progress:${BATCH_ID}`;

/** generation_batch 行记录（只含快照查询会 select 的字段） */
interface BatchRow {
  id: string;
  shopId: string;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  totalCount: number;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
}

function makeBatch(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id: BATCH_ID,
    shopId: SHOP_ID,
    status: 'IN_PROGRESS',
    totalCount: 10,
    completedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.hmget.mockReset();
});

// ============================================================================
// 1. 计数口径
// ============================================================================

describe('getGenerationProgressSnapshot —— 计数口径', () => {
  it('IN_PROGRESS 期间按 DB 计数返回增量（current = completedCount，含跳过与失败）', async () => {
    mocks.findUnique.mockResolvedValue(
      makeBatch({ completedCount: 6, skippedCount: 2, failedCount: 1 }),
    );
    mocks.hmget.mockResolvedValue([null, null]);

    const snapshot = await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.batchId).toBe(BATCH_ID);
    expect(snapshot?.status).toBe('IN_PROGRESS');
    expect(snapshot?.current).toBe(6);
    expect(snapshot?.total).toBe(10);
    expect(snapshot?.skipped).toBe(2);
    expect(snapshot?.failed).toBe(1);
    // 进行中就能拿到递增数字：这正是修复「全程 0」的关键
    expect(snapshot?.current).toBeGreaterThan(0);
  });

  it('查询走 select 白名单，不拉取整行', async () => {
    mocks.findUnique.mockResolvedValue(makeBatch());
    mocks.hmget.mockResolvedValue([null, null]);

    await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    const args = mocks.findUnique.mock.calls.at(-1)?.[0] as {
      where: { id: string };
      select: Record<string, boolean>;
    };
    expect(args.where.id).toBe(BATCH_ID);
    expect(Object.keys(args.select).sort()).toEqual(
      [
        'completedCount',
        'failedCount',
        'id',
        'shopId',
        'skippedCount',
        'status',
        'totalCount',
      ].sort(),
    );
  });
});

// ============================================================================
// 2. 越权与缺失
// ============================================================================

describe('getGenerationProgressSnapshot —— 越权与缺失', () => {
  it('批次不存在返回 null', async () => {
    mocks.findUnique.mockResolvedValue(null);

    await expect(
      getGenerationProgressSnapshot(SHOP_ID, 'gbatch_missing'),
    ).resolves.toBeNull();
    expect(mocks.hmget).not.toHaveBeenCalled();
  });

  it('批次属于其他店铺时返回 null（不泄露进度与写回批次）', async () => {
    mocks.findUnique.mockResolvedValue(makeBatch({ shopId: 'shop_other' }));

    const snapshot = await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    expect(snapshot).toBeNull();
    expect(mocks.hmget).not.toHaveBeenCalled();
  });
});

// ============================================================================
// 3. 自动写回关联字段
// ============================================================================

describe('getGenerationProgressSnapshot —— 自动写回关联字段', () => {
  it('终态快照透传 writebackBatchId，供前端接续写回进度', async () => {
    mocks.findUnique.mockResolvedValue(
      makeBatch({ status: 'COMPLETED', completedCount: 10 }),
    );
    mocks.hmget.mockResolvedValue(['wb_123', null]);

    const snapshot = await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    expect(snapshot?.status).toBe('COMPLETED');
    expect(snapshot?.writebackBatchId).toBe('wb_123');
    expect(snapshot?.writebackError).toBeNull();
  });

  it('终态且自动写回失败时透传 writebackError', async () => {
    mocks.findUnique.mockResolvedValue(
      makeBatch({ status: 'COMPLETED', completedCount: 10 }),
    );
    mocks.hmget.mockResolvedValue([null, 'LOCK_HELD']);

    const snapshot = await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    expect(snapshot?.writebackBatchId).toBeNull();
    expect(snapshot?.writebackError).toBe('LOCK_HELD');
  });

  it('显式空串（确定无需写回）立即返回，不触发 settle 重试', async () => {
    mocks.findUnique.mockResolvedValue(
      makeBatch({ status: 'COMPLETED', completedCount: 10 }),
    );
    mocks.hmget.mockResolvedValue(['', '']);

    const snapshot = await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    expect(snapshot?.writebackBatchId).toBeNull();
    expect(snapshot?.writebackError).toBeNull();
    expect(mocks.hmget).toHaveBeenCalledTimes(1);
    expect(mocks.hmget).toHaveBeenCalledWith(
      PROGRESS_KEY,
      'writebackBatchId',
      'writebackError',
    );
  });

  it('非终态只读一次 Redis，不做 settle 等待', async () => {
    mocks.findUnique.mockResolvedValue(makeBatch({ completedCount: 3 }));
    mocks.hmget.mockResolvedValue([null, null]);

    await getGenerationProgressSnapshot(SHOP_ID, BATCH_ID);

    expect(mocks.hmget).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 4. readAutoWritebackLink 的 settle 语义
// ============================================================================

describe('readAutoWritebackLink —— settle 语义', () => {
  it('字段缺失时在有限次重试后拿到写回批次 ID', async () => {
    mocks.hmget
      .mockResolvedValueOnce([null, null])
      .mockResolvedValueOnce([null, null])
      .mockResolvedValueOnce(['wb_456', '']);

    const link = await readAutoWritebackLink(BATCH_ID, {
      settleAttempts: 5,
      settleDelayMs: 1,
    });

    expect(link).toEqual({ writebackBatchId: 'wb_456', writebackError: null });
    expect(mocks.hmget).toHaveBeenCalledTimes(3);
  });

  it('重试耗尽仍缺失时返回 null 且不再多等一次', async () => {
    mocks.hmget.mockResolvedValue([null, null]);

    const link = await readAutoWritebackLink(BATCH_ID, {
      settleAttempts: 2,
      settleDelayMs: 1,
    });

    expect(link).toEqual({ writebackBatchId: null, writebackError: null });
    expect(mocks.hmget).toHaveBeenCalledTimes(2);
  });

  it('默认单次读取（SSE 推送路径字段必然已落盘，不需要等待）', async () => {
    mocks.hmget.mockResolvedValue([null, null]);

    await readAutoWritebackLink(BATCH_ID);

    expect(mocks.hmget).toHaveBeenCalledTimes(1);
  });

  it('Redis 异常时降级为未关联而非抛错（进度展示优先）', async () => {
    mocks.hmget.mockRejectedValue(new Error('redis down'));

    await expect(readAutoWritebackLink(BATCH_ID)).resolves.toEqual({
      writebackBatchId: null,
      writebackError: null,
    });
  });
});

