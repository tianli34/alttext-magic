/**
 * File: tests/plan-config.test.ts
 * Purpose: 验证计费计划配置常量与 plan-config helper 函数的正确性。
 *          覆盖验收标准中的全部断言。
 */
import assert from 'node:assert/strict';

import { PLAN_CONFIGS, INSTALL_WELCOME, PAID_WELCOME_MAP, ANNUAL_TOTAL_PRICE_CENTS } from '../server/config/plans';
import {
  getPlanConfig,
  getIncludedCredits,
  getAnnualIncludedCredits,
  getMonthlyCycleKey,
  getFreeCycleKey,
  getPaidWelcomeCycleKey,
  getInstallWelcomeCycleKey,
  isPaidPlan,
  canPurchaseOveragePack,
  getInstallWelcomeCredits,
  getPaidWelcomeCredits,
  isValidPlanKey,
  isValidBillingInterval,
} from '../server/modules/billing/plan-config';
import type { PlanKey, BillingInterval } from '../server/modules/billing/billing.types';

// ============================================================================
// 辅助
// ============================================================================

let passed = 0;
let failed = 0;

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertThrows(fn: () => void, label: string): void {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${label}: expected to throw but did not`);
  } catch {
    passed++;
  }
}

// ============================================================================
// 测试主体
// ============================================================================

function run(): void {
  console.log('\n=== plan-config.test.ts ===\n');

  // ------------------------------------------------------------------
  // 1. 验收：Free 月配额返回 25
  // ------------------------------------------------------------------
  {
    const config = getPlanConfig('FREE');
    assertEqual(config.monthlyQuota, 25, 'FREE.monthlyQuota === 25');
    assertEqual(getIncludedCredits('FREE', 'MONTHLY'), 25, 'getIncludedCredits(FREE, MONTHLY) === 25');
    console.log('  ✓ 验收：Free 月配额返回 25');
  }

  // ------------------------------------------------------------------
  // 2. 验收：Starter 月付 included 返回 150
  // ------------------------------------------------------------------
  {
    assertEqual(getIncludedCredits('STARTER', 'MONTHLY'), 150, 'getIncludedCredits(STARTER, MONTHLY) === 150');
    console.log('  ✓ 验收：Starter 月付 included 返回 150');
  }

  // ------------------------------------------------------------------
  // 3. 验收：Growth 年付 included 返回 4200
  // ------------------------------------------------------------------
  {
    assertEqual(getIncludedCredits('GROWTH', 'ANNUAL'), 4200, 'getIncludedCredits(GROWTH, ANNUAL) === 4200');
    assertEqual(getAnnualIncludedCredits('GROWTH'), 4200, 'getAnnualIncludedCredits(GROWTH) === 4200');
    console.log('  ✓ 验收：Growth 年付 included 返回 4200');
  }

  // ------------------------------------------------------------------
  // 4. 验收：新安装欢迎额度返回 50
  // ------------------------------------------------------------------
  {
    assertEqual(INSTALL_WELCOME.credits, 50, 'INSTALL_WELCOME.credits === 50');
    assertEqual(getInstallWelcomeCredits(), 50, 'getInstallWelcomeCredits() === 50');
    console.log('  ✓ 验收：新安装欢迎额度返回 50');
  }

  // ------------------------------------------------------------------
  // 5. 验收：首次付费欢迎额度返回 200（Starter）
  // ------------------------------------------------------------------
  {
    assertEqual(PAID_WELCOME_MAP.STARTER.credits, 200, 'PAID_WELCOME_MAP.STARTER.credits === 200');
    assertEqual(getPaidWelcomeCredits('STARTER'), 200, 'getPaidWelcomeCredits(STARTER) === 200');
    console.log('  ✓ 验收：首次付费欢迎额度 Starter 返回 200');
  }

  // ------------------------------------------------------------------
  // 6. 各档计划配置完整性
  // ------------------------------------------------------------------
  {
    const plans: PlanKey[] = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'MAX'];
    const expectedQuotas = [25, 150, 350, 800, 2000];
    const expectedAnnual = [0, 1800, 4200, 9600, 24000];
    const expectedMonthlyPrices = [0, 499, 999, 1499, 2499];
    const expectedAnnualMonthlyPrices = [0, 349, 699, 1049, 1749];

    for (let i = 0; i < plans.length; i++) {
      const key = plans[i];
      const config = getPlanConfig(key);

      assertEqual(config.monthlyQuota, expectedQuotas[i], `${key}.monthlyQuota`);
      assertEqual(config.annualTotalCredits, expectedAnnual[i], `${key}.annualTotalCredits`);
      assertEqual(config.monthlyPriceCents, expectedMonthlyPrices[i], `${key}.monthlyPriceCents`);
      assertEqual(config.annualMonthlyPriceCents, expectedAnnualMonthlyPrices[i], `${key}.annualMonthlyPriceCents`);
    }
    console.log('  ✓ 各档计划配置完整性校验通过');
  }

  // ------------------------------------------------------------------
  // 7. 年付总价
  // ------------------------------------------------------------------
  {
    assertEqual(ANNUAL_TOTAL_PRICE_CENTS.FREE, 0, 'ANNUAL_TOTAL_PRICE_CENTS.FREE === 0');
    assertEqual(ANNUAL_TOTAL_PRICE_CENTS.STARTER, 4188, 'ANNUAL_TOTAL_PRICE_CENTS.STARTER === 4188');
    assertEqual(ANNUAL_TOTAL_PRICE_CENTS.GROWTH, 8388, 'ANNUAL_TOTAL_PRICE_CENTS.GROWTH === 8388');
    assertEqual(ANNUAL_TOTAL_PRICE_CENTS.PRO, 12588, 'ANNUAL_TOTAL_PRICE_CENTS.PRO === 12588');
    assertEqual(ANNUAL_TOTAL_PRICE_CENTS.MAX, 20988, 'ANNUAL_TOTAL_PRICE_CENTS.MAX === 20988');
    console.log('  ✓ 年付总价校验通过');
  }

  // ------------------------------------------------------------------
  // 8. 付费欢迎额度分级
  // ------------------------------------------------------------------
  {
    assertEqual(getPaidWelcomeCredits('GROWTH'), 500, 'getPaidWelcomeCredits(GROWTH) === 500');
    assertEqual(getPaidWelcomeCredits('PRO'), 1000, 'getPaidWelcomeCredits(PRO) === 1000');
    assertEqual(getPaidWelcomeCredits('MAX'), 3000, 'getPaidWelcomeCredits(MAX) === 3000');
    assertEqual(getPaidWelcomeCredits('FREE'), 0, 'getPaidWelcomeCredits(FREE) === 0');
    console.log('  ✓ 付费欢迎额度分级校验通过');
  }

  // ------------------------------------------------------------------
  // 9. 自动增量扫描
  // ------------------------------------------------------------------
  {
    assertEqual(getPlanConfig('FREE').incrementalScanEnabled, false, 'FREE.incrementalScanEnabled === false');
    assertEqual(getPlanConfig('STARTER').incrementalScanEnabled, true, 'STARTER.incrementalScanEnabled === true');
    assertEqual(getPlanConfig('GROWTH').incrementalScanEnabled, true, 'GROWTH.incrementalScanEnabled === true');
    console.log('  ✓ 自动增量扫描配置校验通过');
  }

  // ------------------------------------------------------------------
  // 10. cycle_key 生成
  // ------------------------------------------------------------------
  {
    // Free 月度 cycle_key
    const jan2025 = new Date('2025-01-15T00:00:00Z');
    assertEqual(getFreeCycleKey(jan2025), 'FREE:2025-01', 'getFreeCycleKey(2025-01) === FREE:2025-01');

    const dec2025 = new Date('2025-12-31T23:59:59Z');
    assertEqual(getFreeCycleKey(dec2025), 'FREE:2025-12', 'getFreeCycleKey(2025-12) === FREE:2025-12');

    // 付费月付 cycle_key
    assertEqual(
      getMonthlyCycleKey(jan2025, 'STARTER', 'MONTHLY'),
      'INCLUDED:STARTER:2025-01',
      'getMonthlyCycleKey(STARTER, MONTHLY, 2025-01)',
    );

    // 付费年付 cycle_key
    assertEqual(
      getMonthlyCycleKey(jan2025, 'GROWTH', 'ANNUAL'),
      'INCLUDED:GROWTH:2025',
      'getMonthlyCycleKey(GROWTH, ANNUAL, 2025)',
    );

    // 安装欢迎 cycle_key
    assertEqual(getInstallWelcomeCycleKey(), 'WELCOME:INSTALL', 'getInstallWelcomeCycleKey() === WELCOME:INSTALL');

    // 付费欢迎 cycle_key
    assertEqual(
      getPaidWelcomeCycleKey('STARTER'),
      'PAID_WELCOME_STARTER',
      'getPaidWelcomeCycleKey(STARTER) === PAID_WELCOME_STARTER',
    );

    console.log('  ✓ cycle_key 生成校验通过');
  }

  // ------------------------------------------------------------------
  // 11. 布尔判断
  // ------------------------------------------------------------------
  {
    assertEqual(isPaidPlan('FREE'), false, 'isPaidPlan(FREE) === false');
    assertEqual(isPaidPlan('STARTER'), true, 'isPaidPlan(STARTER) === true');
    assertEqual(isPaidPlan('GROWTH'), true, 'isPaidPlan(GROWTH) === true');
    assertEqual(isPaidPlan('PRO'), true, 'isPaidPlan(PRO) === true');
    assertEqual(isPaidPlan('MAX'), true, 'isPaidPlan(MAX) === true');

    assertEqual(canPurchaseOveragePack('FREE'), true, 'canPurchaseOveragePack(FREE) === true');
    assertEqual(canPurchaseOveragePack('STARTER'), true, 'canPurchaseOveragePack(STARTER) === true');
    assertEqual(canPurchaseOveragePack('MAX'), true, 'canPurchaseOveragePack(MAX) === true');

    console.log('  ✓ 布尔判断校验通过');
  }

  // ------------------------------------------------------------------
  // 12. 超额包配置
  // ------------------------------------------------------------------
  {
    const freePacks = getPlanConfig('FREE').overagePacks;
    assertEqual(freePacks.length, 1, 'FREE overagePacks.length === 1');
    assertEqual(freePacks[0].credits, 100, 'FREE overagePacks[0].credits === 100');
    assertEqual(freePacks[0].priceCents, 299, 'FREE overagePacks[0].priceCents === 299');

    const growthPacks = getPlanConfig('GROWTH').overagePacks;
    assertEqual(growthPacks[0].credits, 200, 'GROWTH overagePacks[0].credits === 200');
    assertEqual(growthPacks[0].priceCents, 499, 'GROWTH overagePacks[0].priceCents === 499');

    const proPacks = getPlanConfig('PRO').overagePacks;
    assertEqual(proPacks[0].credits, 400, 'PRO overagePacks[0].credits === 400');
    assertEqual(proPacks[0].priceCents, 799, 'PRO overagePacks[0].priceCents === 799');

    const maxPacks = getPlanConfig('MAX').overagePacks;
    assertEqual(maxPacks[0].credits, 800, 'MAX overagePacks[0].credits === 800');
    assertEqual(maxPacks[0].priceCents, 999, 'MAX overagePacks[0].priceCents === 999');

    console.log('  ✓ 超额包配置校验通过');
  }

  // ------------------------------------------------------------------
  // 13. 运行时校验
  // ------------------------------------------------------------------
  {
    assertEqual(isValidPlanKey('FREE'), true, 'isValidPlanKey(FREE) === true');
    assertEqual(isValidPlanKey('UNKNOWN'), false, 'isValidPlanKey(UNKNOWN) === false');
    assertEqual(isValidBillingInterval('MONTHLY'), true, 'isValidBillingInterval(MONTHLY) === true');
    assertEqual(isValidBillingInterval('ANNUAL'), true, 'isValidBillingInterval(ANNUAL) === true');
    assertEqual(isValidBillingInterval('NONE'), false, 'isValidBillingInterval(NONE) === false');

    console.log('  ✓ 运行时校验函数校验通过');
  }

  // ------------------------------------------------------------------
  // 14. 异常场景
  // ------------------------------------------------------------------
  {
    assertThrows(() => getPaidWelcomeCycleKey('FREE'), 'getPaidWelcomeCycleKey(FREE) 应抛出异常');
    console.log('  ✓ 异常场景校验通过');
  }

  // ------------------------------------------------------------------
  // 汇总
  // ------------------------------------------------------------------
  console.log(`\n  总计: ${passed + failed} 项, 通过: ${passed}, 失败: ${failed}\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

run();
