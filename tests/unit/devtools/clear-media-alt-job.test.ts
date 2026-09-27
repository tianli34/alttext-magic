/**
 * File: tests/unit/devtools/clear-media-alt-job.test.ts
 * Purpose: [TEMP-DEVTOOLS] server/modules/devtools/clear-media-alt-job.server.ts 单元测试。
 *          覆盖 Dashboard 临时按钮后台任务管理器的关键行为：
 *          1. 同店铺 RUNNING 期间互斥（第二次启动返回 started=false 与运行中快照）
 *          2. 状态跃迁 RUNNING → SUCCEEDED / FAILED（含 result / error / finishedAt）
 *          3. 日志缓冲的增量游标（after）与 offset 绝对索引语义
 *          4. 日志缓冲上限(600 行)触发丢弃后的 offset 语义
 *          5. isDevToolsEnabled 生产开关
 *
 *          core 模块（会拉起 Prisma/Shopify）与 logger 全部 mock，测试不触达外部依赖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClearMediaAltLog,
  ClearMediaAltResult,
} from '../../../server/modules/devtools/clear-media-alt.core.server';

// core 模块整体替换：runClearMediaAlt 由测试完全掌控（日志回调 + 完成时机）
vi.mock('../../../server/modules/devtools/clear-media-alt.core.server', () => ({
  runClearMediaAlt: (params: unknown) => mocks.runClearMediaAlt(params),
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

const mocks = vi.hoisted(() => ({
  runClearMediaAlt: vi.fn(),
}));

const {
  getClearAltJob,
  isDevToolsEnabled,
  startClearAltJob,
} = await import('../../../server/modules/devtools/clear-media-alt-job.server');

// ============================================================================
// 测试辅助
// ============================================================================

/** 与 core 模块返回值对齐的结果摘要（测试只需部分字段参与断言） */
function makeResult(overrides: Partial<ClearMediaAltResult> = {}): ClearMediaAltResult {
  return {
    shopDomain: 'job-test.myshopify.com',
    dryRun: false,
    scannedPages: 1,
    pendingCount: 3,
    succeeded: 3,
    failed: 0,
    skippedOverlimit: 0,
    samples: [],
    ...overrides,
  };
}

/** 可控完成的 Promise 包装 */
function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, settle: () => resolve };
}

/** 取出最近一次 runClearMediaAlt 调用中的日志回调 */
function lastLogCallback(): ClearMediaAltLog {
  const lastCall = mocks.runClearMediaAlt.mock.calls.at(-1);
  const params = lastCall?.[0] as { log: ClearMediaAltLog } | undefined;
  if (!params?.log) {
    throw new Error('runClearMediaAlt 未被调用，无法取到日志回调');
  }
  return params.log;
}

/** 冲刷微任务队列，让 job 模块的 .then/.catch 回调执行完毕 */
async function flush(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** 启动一次任务，返回任务结果 + 可控的完成闸门 */
function startDeferredJob(shopDomain: string, apply: boolean) {
  const gate = deferred<ClearMediaAltResult>();
  mocks.runClearMediaAlt.mockImplementation(() => gate.promise);
  const started = startClearAltJob({ shopDomain, apply });
  return { ...started, gate };
}

beforeEach(() => {
  mocks.runClearMediaAlt.mockReset();
});

// ============================================================================
// 1. 互斥
// ============================================================================

describe('startClearAltJob 互斥', () => {
  it('同一店铺 RUNNING 期间第二次启动被拒绝，并返回运行中任务快照', () => {
    const first = startDeferredJob('mutex-a.myshopify.com', false);
    expect(first.started).toBe(true);
    expect(first.job.status).toBe('RUNNING');
    expect(first.job.apply).toBe(false);

    const second = startClearAltJob({
      shopDomain: 'mutex-a.myshopify.com',
      apply: true,
    });

    expect(second.started).toBe(false);
    expect(second.job.jobId).toBe(first.job.jobId);
    // 互斥时返回的是运行中任务的信息，不会被新请求覆盖
    expect(second.job.apply).toBe(false);
    expect(mocks.runClearMediaAlt).toHaveBeenCalledTimes(1);
  });

  it('任务结束后可再次启动（生成新 jobId）', async () => {
    const first = startDeferredJob('mutex-b.myshopify.com', true);
    first.gate.settle()?.(makeResult());
    await flush();

    const second = startDeferredJob('mutex-b.myshopify.com', true);
    expect(second.started).toBe(true);
    expect(second.job.jobId).not.toBe(first.job.jobId);
  });

  it('不同店铺互不影响', () => {
    startDeferredJob('mutex-c1.myshopify.com', true);
    const other = startClearAltJob({
      shopDomain: 'mutex-c2.myshopify.com',
      apply: true,
    });
    expect(other.started).toBe(true);
  });
});

// ============================================================================
// 2. 状态跃迁
// ============================================================================

describe('任务状态与结果', () => {
  it('core 成功返回后快照为 SUCCEEDED 并带 result/finishedAt', async () => {
    const { gate, job } = startDeferredJob('state-ok.myshopify.com', true);
    gate.settle()?.(makeResult({ pendingCount: 7, succeeded: 7 }));
    await flush();

    const snapshot = getClearAltJob('state-ok.myshopify.com');
    expect(snapshot?.jobId).toBe(job.jobId);
    expect(snapshot?.status).toBe('SUCCEEDED');
    expect(snapshot?.finishedAt).not.toBeNull();
    expect(snapshot?.result?.pendingCount).toBe(7);
    expect(snapshot?.error).toBeNull();
  });

  it('core 抛错后快照为 FAILED 并带 error 文案', async () => {
    mocks.runClearMediaAlt.mockRejectedValue(new Error('token 已失效'));
    startClearAltJob({ shopDomain: 'state-err.myshopify.com', apply: false });

    await flush();

    const snapshot = getClearAltJob('state-err.myshopify.com');
    expect(snapshot?.status).toBe('FAILED');
    expect(snapshot?.error).toBe('token 已失效');
    expect(snapshot?.result).toBeNull();
  });

  it('无任务的店铺返回 null', () => {
    expect(getClearAltJob('never-started.myshopify.com')).toBeNull();
  });
});

// ============================================================================
// 3. 日志增量游标与 offset
// ============================================================================

describe('日志增量游标', () => {
  it('after 只回传增量，offset 为切片首行的绝对索引', () => {
    const { gate } = startDeferredJob('log-a.myshopify.com', false);

    lastLogCallback()('L0\nL1\nL2\nL3');

    const full = getClearAltJob('log-a.myshopify.com');
    expect(full?.logs).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(full?.offset).toBe(0);

    const incremental = getClearAltJob('log-a.myshopify.com', 2);
    expect(incremental?.logs).toEqual(['L2', 'L3']);
    expect(incremental?.offset).toBe(2);

    // 游标越界 → 空切片，offset 收敛到日志末尾（客户端据此不重复追加）
    const beyond = getClearAltJob('log-a.myshopify.com', 99);
    expect(beyond?.logs).toEqual([]);
    expect(beyond?.offset).toBe(4);

    gate.settle()?.(makeResult());
  });

  it('超出缓冲上限(600 行)后丢弃旧行，offset 从丢弃量起算且小游标被钳制', () => {
    const { gate } = startDeferredJob('log-b.myshopify.com', true);

    lastLogCallback()(
      Array.from({ length: 700 }, (_, index) => `L${index}`).join('\n'),
    );

    const full = getClearAltJob('log-b.myshopify.com');
    expect(full?.logs).toHaveLength(600);
    expect(full?.droppedLogLines).toBe(100);
    expect(full?.offset).toBe(100);
    expect(full?.logs[0]).toBe('L100');

    // 客户端游标落在已丢弃区间 → 整体回传，offset 仍为 100（客户端识别为需整体替换）
    const stale = getClearAltJob('log-b.myshopify.com', 50);
    expect(stale?.offset).toBe(100);
    expect(stale?.logs[0]).toBe('L100');

    const incremental = getClearAltJob('log-b.myshopify.com', 300);
    expect(incremental?.offset).toBe(300);
    expect(incremental?.logs[0]).toBe('L300');

    gate.settle()?.(makeResult());
  });
});

// ============================================================================
// 4. 生产开关
// ============================================================================

describe('isDevToolsEnabled', () => {
  it('生产环境默认关闭，ENABLE_DEV_TOOLS=1 可强制打开', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ENABLE_DEV_TOOLS', '');
    expect(isDevToolsEnabled()).toBe(false);

    vi.stubEnv('ENABLE_DEV_TOOLS', '1');
    expect(isDevToolsEnabled()).toBe(true);

    vi.unstubAllEnvs();
  });

  it('非生产环境默认打开', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ENABLE_DEV_TOOLS', '');
    expect(isDevToolsEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

