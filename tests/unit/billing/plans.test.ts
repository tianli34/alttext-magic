/**
 * File: tests/unit/billing/plans.test.ts
 * Purpose: 计费计划配置常量（server/config/plans.ts）不变量校验。
 *          防止后续调整价格/配额时破坏配置间的数学一致性。
 */
import { describe, expect, it } from 'vitest';

import {
  ANNUAL_TOTAL_PRICE_CENTS,
  INSTALL_WELCOME,
  PAID_WELCOME_MAP,
  PLAN_CONFIGS,
  formatPriceCents,
} from '../../../server/config/plans';
import { PLAN_KEYS } from '../../../server/modules/billing/billing.types';

/** 付费计划列表（排除 FREE） */
const PAID_PLAN_KEYS = PLAN_KEYS.filter((key) => key !== 'FREE');

describe('计划配置不变量', () => {
  it('付费计划年付发放总量 = 12 × 月配额', () => {
    for (const planKey of PAID_PLAN_KEYS) {
      const config = PLAN_CONFIGS[planKey];
      expect(config.annualTotalCredits, `${planKey}.annualTotalCredits`).toBe(config.monthlyQuota * 12);
    }
  });

  it('年付总价 = 年付折算月价 × 12', () => {
    for (const planKey of PLAN_KEYS) {
      const config = PLAN_CONFIGS[planKey];
      expect(ANNUAL_TOTAL_PRICE_CENTS[planKey], `${planKey} 年付总价`).toBe(
        config.annualMonthlyPriceCents * 12,
      );
    }
  });

  it('付费计划年付折算月价应低于月付价格（年付优惠）', () => {
    for (const planKey of PAID_PLAN_KEYS) {
      const config = PLAN_CONFIGS[planKey];
      expect(
        config.annualMonthlyPriceCents < config.monthlyPriceCents,
        `${planKey} 年付月价应低于月付价格`,
      ).toBe(true);
    }
  });

  it('FREE 计划价格为零且关闭自动增量扫描', () => {
    const free = PLAN_CONFIGS.FREE;
    expect(free.monthlyPriceCents).toBe(0);
    expect(free.annualMonthlyPriceCents).toBe(0);
    expect(free.incrementalScanEnabled).toBe(false);
  });

  it('每档计划至少提供一个超额包，且同一计划内 packCode 不重复', () => {
    // 注意：FREE 与 STARTER 按设计共享同一超额包（OVERAGE_100_299），
    // 因此 packCode 仅要求在单个计划内唯一，而非全局唯一。
    for (const planKey of PLAN_KEYS) {
      const packs = PLAN_CONFIGS[planKey].overagePacks;
      expect(packs.length, `${planKey} 应至少有一个超额包`).toBeGreaterThan(0);
      const packCodes = new Set<string>();
      for (const pack of packs) {
        expect(pack.credits).toBeGreaterThan(0);
        expect(pack.priceCents).toBeGreaterThan(0);
        expect(packCodes.has(pack.packCode), `${planKey} 内 packCode ${pack.packCode} 重复`).toBe(false);
        packCodes.add(pack.packCode);
      }
    }
  });

  it('付费计划必须配置首次付费欢迎额度，FREE 不得配置', () => {
    expect(PLAN_CONFIGS.FREE.paidWelcome).toBeUndefined();
    for (const planKey of PAID_PLAN_KEYS) {
      expect(PLAN_CONFIGS[planKey].paidWelcome, `${planKey} 缺少 paidWelcome`).toBeDefined();
      // 计划内嵌配置须与全局 PAID_WELCOME_MAP 一致
      expect(PLAN_CONFIGS[planKey].paidWelcome).toBe(PAID_WELCOME_MAP[planKey]);
    }
  });

  it('安装欢迎额度配置完整', () => {
    expect(INSTALL_WELCOME.credits).toBeGreaterThan(0);
    expect(INSTALL_WELCOME.cycleKeyTag).toBe('WELCOME:INSTALL');
  });
});

describe('formatPriceCents', () => {
  it('常规美分价格格式化为美元字符串', () => {
    expect(formatPriceCents(499)).toBe('$4.99');
    expect(formatPriceCents(2499)).toBe('$24.99');
  });

  it('零价格格式化为 $0.00', () => {
    expect(formatPriceCents(0)).toBe('$0.00');
  });

  it('不足一美元的价格保留两位小数', () => {
    expect(formatPriceCents(5)).toBe('$0.05');
  });
});
