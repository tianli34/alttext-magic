/**
 * File: tests/unit/billing/plan-config.test.ts
 * Purpose: 计费计划查询 helper（server/modules/billing/plan-config.ts）单元测试。
 *          覆盖：基础查询、included 额度计算、cycle_key 生成、布尔判断、
 *          欢迎额度查询、运行时校验、异常场景。
 */
import { describe, expect, it } from 'vitest';

import {
  canPurchaseOveragePack,
  getAnnualIncludedCredits,
  getFreeCycleKey,
  getIncludedCredits,
  getInstallWelcomeCredits,
  getInstallWelcomeCycleKey,
  getMonthlyCycleKey,
  getPaidWelcomeCredits,
  getPaidWelcomeCycleKey,
  getPlanConfig,
  isPaidPlan,
  isValidBillingInterval,
  isValidPlanKey,
} from '../../../server/modules/billing/plan-config';
import { PLAN_KEYS } from '../../../server/modules/billing/billing.types';

// ============================================================================
// 基础查询
// ============================================================================

describe('getPlanConfig', () => {
  it('五档计划均可取到配置且 planKey 自洽', () => {
    for (const planKey of PLAN_KEYS) {
      expect(getPlanConfig(planKey).planKey).toBe(planKey);
    }
  });

  it('非法 planKey 应抛出异常', () => {
    // 运行时防御：绕过 TS 类型约束模拟脏数据
    expect(() => getPlanConfig('UNKNOWN' as never)).toThrow(/未知的计划标识/);
  });
});

// ============================================================================
// included 额度计算
// ============================================================================

describe('getIncludedCredits', () => {
  it('FREE 月配额返回 25', () => {
    expect(getIncludedCredits('FREE', 'MONTHLY')).toBe(25);
  });

  it('FREE 忽略 interval 参数，ANNUAL 也返回月配额', () => {
    expect(getIncludedCredits('FREE', 'ANNUAL')).toBe(25);
  });

  it('STARTER 月付返回 150，年付返回 1800', () => {
    expect(getIncludedCredits('STARTER', 'MONTHLY')).toBe(150);
    expect(getIncludedCredits('STARTER', 'ANNUAL')).toBe(1800);
  });

  it('GROWTH 年付返回 4200', () => {
    expect(getIncludedCredits('GROWTH', 'ANNUAL')).toBe(4200);
  });
});

describe('getAnnualIncludedCredits', () => {
  it('GROWTH 年付一次性发放 4200', () => {
    expect(getAnnualIncludedCredits('GROWTH')).toBe(4200);
  });

  it('MAX 年付一次性发放 24000', () => {
    expect(getAnnualIncludedCredits('MAX')).toBe(24000);
  });

  // FREE 无年付形态，年付发放总量为 0（不复用 getIncludedCredits 的 FREE 月配额特例）
  it('FREE 无年付形态，返回 0', () => {
    expect(getAnnualIncludedCredits('FREE')).toBe(0);
  });
});

// ============================================================================
// cycle_key 生成
// ============================================================================

describe('cycle_key 生成', () => {
  // 固定 UTC 锚点，避免本地时区干扰
  const anchor = new Date('2026-03-05T12:00:00.000Z');

  it('月付 cycle_key 格式为 INCLUDED:{planKey}:YYYY-MM', () => {
    expect(getMonthlyCycleKey(anchor, 'STARTER', 'MONTHLY')).toBe('INCLUDED:STARTER:2026-03');
  });

  it('年付 cycle_key 格式为 INCLUDED:{planKey}:YYYY', () => {
    expect(getMonthlyCycleKey(anchor, 'GROWTH', 'ANNUAL')).toBe('INCLUDED:GROWTH:2026');
  });

  it('月份个位数需补零', () => {
    const january = new Date('2026-01-15T00:00:00.000Z');
    expect(getMonthlyCycleKey(january, 'PRO', 'MONTHLY')).toBe('INCLUDED:PRO:2026-01');
  });

  it('Free 月配额 cycle_key 格式为 FREE:YYYY-MM', () => {
    expect(getFreeCycleKey(anchor)).toBe('FREE:2026-03');
  });

  it('首次付费欢迎额度 cycle_key 按计划分级', () => {
    expect(getPaidWelcomeCycleKey('STARTER')).toBe('PAID_WELCOME_STARTER');
    expect(getPaidWelcomeCycleKey('MAX')).toBe('PAID_WELCOME_MAX');
  });

  it('FREE 无付费欢迎额度，应抛出异常', () => {
    expect(() => getPaidWelcomeCycleKey('FREE')).toThrow(/FREE 计划无付费欢迎额度/);
  });

  it('安装欢迎额度 cycle_key 全局唯一', () => {
    expect(getInstallWelcomeCycleKey()).toBe('WELCOME:INSTALL');
  });
});

// ============================================================================
// 布尔判断
// ============================================================================

describe('isPaidPlan', () => {
  it('FREE 不是付费计划', () => {
    expect(isPaidPlan('FREE')).toBe(false);
  });

  it('其余四档均为付费计划', () => {
    for (const planKey of PLAN_KEYS.filter((key) => key !== 'FREE')) {
      expect(isPaidPlan(planKey)).toBe(true);
    }
  });
});

describe('canPurchaseOveragePack', () => {
  it('所有计划均可购买超额包', () => {
    for (const planKey of PLAN_KEYS) {
      expect(canPurchaseOveragePack(planKey)).toBe(true);
    }
  });
});

// ============================================================================
// 欢迎额度查询
// ============================================================================

describe('欢迎额度查询', () => {
  it('安装欢迎额度为 50', () => {
    expect(getInstallWelcomeCredits()).toBe(50);
  });

  it('FREE 首次付费欢迎额度返回 0', () => {
    expect(getPaidWelcomeCredits('FREE')).toBe(0);
  });

  it('STARTER 首次付费欢迎额度为 200', () => {
    expect(getPaidWelcomeCredits('STARTER')).toBe(200);
  });

  it('MAX 首次付费欢迎额度为 3000', () => {
    expect(getPaidWelcomeCredits('MAX')).toBe(3000);
  });
});

// ============================================================================
// 运行时校验
// ============================================================================

describe('运行时校验', () => {
  it('isValidPlanKey 识别合法与非法值', () => {
    expect(isValidPlanKey('FREE')).toBe(true);
    expect(isValidPlanKey('MAX')).toBe(true);
    expect(isValidPlanKey('UNKNOWN')).toBe(false);
    expect(isValidPlanKey('')).toBe(false);
  });

  it('isValidBillingInterval 仅接受 MONTHLY / ANNUAL', () => {
    expect(isValidBillingInterval('MONTHLY')).toBe(true);
    expect(isValidBillingInterval('ANNUAL')).toBe(true);
    expect(isValidBillingInterval('NONE')).toBe(false);
    expect(isValidBillingInterval('monthly')).toBe(false);
  });
});
