/**
 * File: tests/e2e/tally-recovery.spec.ts
 * Purpose: 场景 1——刷新恢复路径的生成计数回填在鉴权竞态下必须自愈，
 *          不得出现「生成阶段计数未能取得」。
 *
 *          复现原缺陷的确定性条件：写回进行中刷新页面（恢复路径直进 WRITEBACK、
 *          生成阶段 SSE 不再激活，内存 tally 丢失），且回填首试撞上鉴权竞态。
 *          历史实现「单发、失败即放弃」在此概率性把占位符永久留下。
 *
 *          故障注入：/api/generation/batch/* 前两次请求返回 401，第 3 次放行。
 *          401 与真实令牌竞态（302→401）走重试循环的同一瞬态分支，故测的
 *          是被修的那条路径，不是平行实现。
 *
 *          为什么篡改 sessionStorage：现行实现在生成完成时把计数一并持久化，
 *          正常刷新不会发起回填；抹去 generationTally 模拟「未持久化 tally 的
 *          旧会话/降级」（恢复逻辑的显式兼容分支），回填循环才能被置于测试之下。
 */
import { expect, test } from "@playwright/test";
import { gotoCandidatesPage, openApp, waitForAppFrame } from "./helpers/app-frame";
import {
  readPersistedGeneration,
  startGenerationWithAutoWriteback,
  stripPersistedGenerationTally,
} from "./helpers/generation-flow";

test("刷新恢复：回填在 401 竞态下重试直至成功，汇总计数完整", async ({ page }) => {
  const frame = await openApp(page);
  await gotoCandidatesPage(frame);

  // 走真实 UI：勾选候选 → 生成 → 等待生成终态且自动写回批次关联落盘
  await startGenerationWithAutoWriteback(frame);

  // 模拟降级会话：抹去持久化的生成计数，刷新后恢复路径必须发起异步回填
  await stripPersistedGenerationTally(frame);

  // 注入确定性鉴权竞态：前两次计数快照请求 401，其后放行
  // （此端点在恢复路径下只有回填循环一个调用方：写回进度走 /api/writeback/*，
  //   生成 SSE 在 WRITEBACK 阶段不激活，注入不影响其他通道）
  const hydrationAttempts: number[] = [];
  await page.route("**/api/generation/batch/*", async (route) => {
    hydrationAttempts.push(1);
    if (hydrationAttempts.length <= 2) {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":"Unauthorized"}',
      });
      return;
    }
    await route.continue();
  });

  // 刷新（等价于用户在写回进行中按 F5）：admin 外壳与 iframe 全部真实重建
  await page.reload();
  const recoveredFrame = await waitForAppFrame(page);

  // 汇总弹出：写回终态经 SSE/轮询真实送达后组装
  const summaryHeading = recoveredFrame.getByText(/生成(完成|已结束)/);
  await summaryHeading.waitFor({ state: "visible", timeout: 10 * 60_000 });

  // 断言 1：回填确实被 401 打断过并重试成功（证明测的是重试循环，而非碰巧没触发）
  expect(hydrationAttempts.length).toBeGreaterThanOrEqual(3);

  // 断言 2：生成汇总卡片存在（generationRan 语义成立，排除「仅写回」的假阴性）
  await expect(recoveredFrame.getByText("生成结果")).toBeVisible();

  // 断言 3：核心症状不再出现——「计数未能取得」提示不渲染（渲染条件为
  // generationRan 且生成侧任一项为 null；卡片在场的前提下缺席即计数已取得）
  await expect(recoveredFrame.getByText("生成阶段计数未能取得")).toHaveCount(0);

  // 断言 4：三个生成计数均为真实数字而非占位符「—」
  const successCard = recoveredFrame.getByText("成功", { exact: true }).locator("xpath=..");
  await expect(successCard.locator("span").first()).toHaveText(/^\d+$/);
  const skippedCard = recoveredFrame
    .getByText("跳过（已有 Alt）", { exact: true })
    .locator("xpath=..");
  await expect(skippedCard.locator("span").first()).toHaveText(/^\d+$/);
  const failedCard = recoveredFrame.getByText("失败", { exact: true }).locator("xpath=..");
  await expect(failedCard.locator("span").first()).toHaveText(/^\d+$/);

  // 断言 5：写回结果照常有数（原缺陷的另一半表征：写回有数、生成未知）
  await expect(recoveredFrame.getByText("自动写回结果")).toBeVisible();

  // 断言 6：回填成功后计数已回写持久化（恢复路径闭环，再次刷新可直接命中）
  const persisted = await readPersistedGeneration(recoveredFrame);
  expect(persisted?.generationTally).not.toBeNull();

  // 收尾：关闭汇总回到 IDLE，清掉持久化，避免影响下一次运行
  await recoveredFrame.getByText("返回候选列表").click();
  await expect(summaryHeading).toHaveCount(0);
});
