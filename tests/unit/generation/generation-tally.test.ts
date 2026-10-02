/**
 * File: tests/unit/generation/generation-tally.test.ts
 * Purpose: 生成计数派生工具与刷新恢复回填循环的单元测试。
 *          背景：汇总弹窗的「生成成功」不是服务端权威字段，而是由生成进度快照派生。
 *          该派生量原先只存于内存 ref，刷新（恢复路径直接进 WRITEBACK，生成阶段
 *          SSE 不再激活）后必然丢失，随后被兜底成 0，出现「生成成功 0 / 写回成功 94」
 *          这种自相矛盾的汇总。修复要点有二：
 *          1. 派生口径与 worker 一致（succeeded = total - skipped - failed）；
 *          2. 「取不到」必须与「确实是 0」区分开，不得把未知渲染成 0。
 *          其后回填由「单发、失败即放弃」改为「失败静默、按固定间隔重试直至成功」
 *          （与写回进度轮询兜底对齐）：单发首试常撞上刷新后的鉴权/令牌竞态，
 *          「生成阶段计数未能取得」因此概率性出现。
 *          本测试覆盖派生口径、未知语义与回填循环的取数策略。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  GENERATION_TALLY_RETRY_DELAY_MS,
  hydrateGenerationTallyWithRetry,
  isGenerationTallySnapshot,
  toGenerationTally,
} from '../../../app/lib/generation-tally';

describe('toGenerationTally', () => {
  it('按 total - skipped - failed 派生成功数（与 worker 计数同口径）', () => {
    expect(toGenerationTally({ total: 94, skipped: 0, failed: 0 })).toEqual({
      total: 94,
      succeeded: 94,
      skipped: 0,
      failed: 0,
    });
  });

  it('扣除跳过与失败后得到成功数', () => {
    expect(toGenerationTally({ total: 10, skipped: 3, failed: 2 })).toEqual({
      total: 10,
      succeeded: 5,
      skipped: 3,
      failed: 2,
    });
  });

  it('计数瞬态导致派生为负时归零，不向界面输出负值', () => {
    const tally = toGenerationTally({ total: 1, skipped: 2, failed: 1 });

    expect(tally.succeeded).toBe(0);
    expect(tally.skipped).toBe(2);
    expect(tally.failed).toBe(1);
  });

  it('全部跳过时成功数为 0（此处的 0 是真实值，可与「未知」区分）', () => {
    expect(toGenerationTally({ total: 4, skipped: 4, failed: 0 }).succeeded).toBe(0);
  });
});

describe('isGenerationTallySnapshot', () => {
  it('接受字段齐全的快照（轮询接口返回体是其超集）', () => {
    expect(
      isGenerationTallySnapshot({
        batchId: 'batch_1',
        status: 'COMPLETED',
        current: 94,
        total: 94,
        skipped: 0,
        failed: 0,
        writebackBatchId: 'wb_1',
        writebackError: null,
      }),
    ).toBe(true);
  });

  it('缺少计数字段时判定不可用（调用方须保留「未知」，不得退化成 0）', () => {
    expect(isGenerationTallySnapshot({ total: 94 })).toBe(false);
    expect(isGenerationTallySnapshot({ total: 94, skipped: 0 })).toBe(false);
  });

  it('非对象或 null 判定不可用', () => {
    expect(isGenerationTallySnapshot(null)).toBe(false);
    expect(isGenerationTallySnapshot('94')).toBe(false);
    expect(isGenerationTallySnapshot({ total: '94', skipped: 0, failed: 0 })).toBe(false);
  });

  it('错误响应体（仅有 error 字段）判定不可用', () => {
    expect(isGenerationTallySnapshot({ error: 'Generation batch not found' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hydrateGenerationTallyWithRetry：刷新恢复路径的回填取数策略
// ---------------------------------------------------------------------------

function okResponse(payload: unknown) {
  return { ok: true, status: 200, json: async () => payload };
}

function errorResponse(status: number) {
  return { ok: false, status, json: async () => ({ error: 'Generation batch not found' }) };
}

describe('hydrateGenerationTallyWithRetry', () => {
  it('首试成功即落地计数并返回，不再进入重试等待', async () => {
    const onTally = vi.fn();
    const delay = vi.fn(() => Promise.resolve());

    await hydrateGenerationTallyWithRetry({
      fetchSnapshot: async () => okResponse({ total: 94, skipped: 2, failed: 1 }),
      onTally,
      delay,
    });

    expect(onTally).toHaveBeenCalledTimes(1);
    expect(onTally).toHaveBeenCalledWith({ total: 94, succeeded: 91, skipped: 2, failed: 1 });
    expect(delay).not.toHaveBeenCalled();
  });

  it('404 视为确定性失败：不落地、不重试，保持「未知」语义', async () => {
    const onTally = vi.fn();
    const delay = vi.fn(() => Promise.resolve());

    await hydrateGenerationTallyWithRetry({
      fetchSnapshot: async () => errorResponse(404),
      onTally,
      delay,
    });

    expect(onTally).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it('瞬态失败（网络抛错/401/载荷不符口径）按间隔静默重试直至成功', async () => {
    const onTally = vi.fn();
    let attempts = 0;
    const delays: number[] = [];

    await hydrateGenerationTallyWithRetry({
      fetchSnapshot: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network down');
        if (attempts === 2) return errorResponse(401);
        // 200 但载荷不符合口径（如代理注入非 JSON 响应体）：同样按瞬态重试
        if (attempts === 3) return okResponse({ error: 'Unexpected' });
        return okResponse({ total: 10, skipped: 3, failed: 2 });
      },
      onTally,
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    expect(attempts).toBe(4);
    expect(delays).toEqual([
      GENERATION_TALLY_RETRY_DELAY_MS,
      GENERATION_TALLY_RETRY_DELAY_MS,
      GENERATION_TALLY_RETRY_DELAY_MS,
    ]);
    expect(onTally).toHaveBeenCalledTimes(1);
    expect(onTally).toHaveBeenCalledWith({ total: 10, succeeded: 5, skipped: 3, failed: 2 });
  });

  it('启动前已失效（teardown 先于回填）时不发起任何取数', async () => {
    const fetchSnapshot = vi.fn();

    await hydrateGenerationTallyWithRetry({
      fetchSnapshot,
      onTally: vi.fn(),
      isCancelled: () => true,
    });

    expect(fetchSnapshot).not.toHaveBeenCalled();
  });

  it('取数响应期间 teardown：不落地计数、不继续轮询', async () => {
    const onTally = vi.fn();
    let cancelled = false;

    await hydrateGenerationTallyWithRetry({
      fetchSnapshot: async () => {
        cancelled = true; // 模拟取数期间发生 teardown（cancel/closeSummary/组件卸载）
        return okResponse({ total: 94, skipped: 0, failed: 0 });
      },
      onTally,
      delay: async () => {},
      isCancelled: () => cancelled,
    });

    expect(onTally).not.toHaveBeenCalled();
  });

  it('json 落地瞬间 teardown：核对与落地同处同步块，同样不落状态', async () => {
    const onTally = vi.fn();
    let cancelled = false;

    await hydrateGenerationTallyWithRetry({
      fetchSnapshot: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => {
            cancelled = true;
            return { total: 94, skipped: 0, failed: 0 };
          },
        }),
      onTally,
      delay: async () => {},
      isCancelled: () => cancelled,
    });

    expect(onTally).not.toHaveBeenCalled();
  });
});