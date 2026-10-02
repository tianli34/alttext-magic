/**
 * File: tests/unit/generation/generation-tally.test.ts
 * Purpose: 生成计数派生工具的单元测试。
 *          背景：汇总弹窗的「生成成功」不是服务端权威字段，而是由生成进度快照派生。
 *          该派生量原先只存于内存 ref，刷新（恢复路径直接进 WRITEBACK，生成阶段
 *          SSE 不再激活）后必然丢失，随后被兜底成 0，出现「生成成功 0 / 写回成功 94」
 *          这种自相矛盾的汇总。修复要点有二：
 *          1. 派生口径与 worker 一致（succeeded = total - skipped - failed）；
 *          2. 「取不到」必须与「确实是 0」区分开，不得把未知渲染成 0。
 *          本测试覆盖这两点。
 */
import { describe, expect, it } from 'vitest';

import {
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