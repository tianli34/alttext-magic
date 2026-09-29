/**
 * File: tests/unit/devtools/reset-pending-targets.test.ts
 * Purpose: [TEMP-DEVTOOLS] classifyPendingResetTargets 单元测试。
 *          「待生成生产器」的分类口径：
 *            1. 装饰性标记激活 → 跳过（商家设置，统计口径本就不算待生成）
 *            2. 候选 GENERATING → 跳过（不打断在跑的生成任务）
 *            3. 其余可复位：有候选行走 update 桶，无候选行走 create 桶（补建 INITIAL）
 *          Prisma 单例 mock 成空对象，测试不连库。
 */
import { describe, expect, it, vi } from 'vitest';
import { AltCandidateStatus } from '@prisma/client';
import type { PendingResetTargetRow } from '../../../server/modules/devtools/reset-pending-targets.core.server';

vi.mock('../../../server/db/prisma.server', () => ({ default: {} }));

const { classifyPendingResetTargets } = await import(
  '../../../server/modules/devtools/reset-pending-targets.core.server'
);

/** 构造一行候选 target（默认可复位：非装饰 + 已有 GENERATED 候选） */
function row(
  overrides: Partial<PendingResetTargetRow> & { id: string },
): PendingResetTargetRow {
  return {
    decorativeActive: false,
    candidateId: `cand-${overrides.id}`,
    candidateStatus: AltCandidateStatus.GENERATED,
    ...overrides,
  };
}

describe('classifyPendingResetTargets', () => {
  it('空输入返回空计划', () => {
    const plan = classifyPendingResetTargets([]);
    expect(plan.targetIds).toEqual([]);
    expect(plan.existingCandidateTargetIds).toEqual([]);
    expect(plan.missingCandidateTargetIds).toEqual([]);
    expect(plan.candidateIds).toEqual([]);
    expect(plan.skippedDecorative).toBe(0);
    expect(plan.skippedGenerating).toBe(0);
  });

  it('已有候选行的 target 进 update 桶，并登记待删草稿的候选 id', () => {
    const plan = classifyPendingResetTargets([
      row({ id: 't1', candidateId: 'c1' }),
      row({ id: 't2', candidateId: 'c2', candidateStatus: AltCandidateStatus.INITIAL }),
    ]);

    expect(plan.targetIds).toEqual(['t1', 't2']);
    expect(plan.existingCandidateTargetIds).toEqual(['t1', 't2']);
    expect(plan.missingCandidateTargetIds).toEqual([]);
    // 即便候选已是 INITIAL 也统一删草稿：残留草稿会被收敛回 GENERATED(待写回)
    expect(plan.candidateIds).toEqual(['c1', 'c2']);
  });

  it('缺候选行的 target 进 create 桶（补建 INITIAL 候选，否则统计/一键处理取不到）', () => {
    const plan = classifyPendingResetTargets([
      row({ id: 't1', candidateId: null, candidateStatus: null }),
      row({ id: 't2' }),
    ]);

    expect(plan.targetIds).toEqual(['t1', 't2']);
    expect(plan.missingCandidateTargetIds).toEqual(['t1']);
    expect(plan.existingCandidateTargetIds).toEqual(['t2']);
    expect(plan.candidateIds).toEqual(['cand-t2']);
  });

  it('装饰性标记激活的 target 被跳过', () => {
    const plan = classifyPendingResetTargets([
      row({ id: 't1', decorativeActive: true }),
      row({ id: 't2' }),
    ]);

    expect(plan.targetIds).toEqual(['t2']);
    expect(plan.skippedDecorative).toBe(1);
  });

  it('GENERATING 候选被跳过，避免打断在跑的生成任务', () => {
    const plan = classifyPendingResetTargets([
      row({ id: 't1', candidateStatus: AltCandidateStatus.GENERATING }),
      row({ id: 't2', candidateStatus: AltCandidateStatus.WRITTEN }),
    ]);

    expect(plan.targetIds).toEqual(['t2']);
    expect(plan.skippedGenerating).toBe(1);
    expect(plan.skippedDecorative).toBe(0);
  });

  it('装饰性判定优先于生成中判定', () => {
    const plan = classifyPendingResetTargets([
      row({
        id: 't1',
        decorativeActive: true,
        candidateStatus: AltCandidateStatus.GENERATING,
      }),
    ]);

    expect(plan.targetIds).toEqual([]);
    expect(plan.skippedDecorative).toBe(1);
    expect(plan.skippedGenerating).toBe(0);
  });
});
