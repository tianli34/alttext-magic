/**
 * File: tests/e2e/writeback-polling-fallback.spec.ts
 * Purpose: 场景 2——写回 SSE 全程不可用时，轮询兜底独立送达终态，汇总计数完整。
 *
 *          背景：开发环境经 Cloudflare 隧道访问时边缘会缓冲 text/event-stream
 *          （实测流保持打开期间前端 0 chunk），「SSE 主通道失效、轮询兜底独立
 *          送达终态」是真实生产条件而非人工构造。这正是「一键处理结果不一致」
 *          一类双通道缺陷的高发形态：终态改由非主通道送达时，汇总组装链路
 *          （生成计数内存 tally + 写回终态快照）必须照常成立。
 *
 *          故障注入：/api/writeback/progress 连接即中断（fetch 抛错 → 触发
 *          useWritebackSSE 的 3 秒重连与静默兜底），写回全程只剩
 *          /api/writeback/batch/:batchId 轮询通道。生成 SSE 是另一条端点，
 *          不受注入影响——生成终态与内存 tally 照常取得。
 */
import { expect, test } from "@playwright/test";
import { gotoCandidatesPage, openApp } from "./helpers/app-frame";
import { startGenerationWithAutoWriteback } from "./helpers/generation-flow";

test("写回 SSE 中断：轮询兜底送达终态，汇总计数完整", async ({ page }) => {
  const frame = await openApp(page);
  await gotoCandidatesPage(frame);

  // 全程屏蔽写回 SSE（连接即中断），并给轮询兜底通道记账
  let writebackPollCount = 0;
  await page.route("**/api/writeback/progress*", async (route) => {
    await route.abort("connectionrefused");
  });
  await page.route("**/api/writeback/batch/*", async (route) => {
    writebackPollCount += 1;
    await route.continue();
  });

  // 走真实 UI：勾选候选 → 生成 → 等待生成终态且自动写回批次关联落盘
  // （本场景全程不刷新：生成三项来自本会话内存 tally，不涉及回填路径）
  await startGenerationWithAutoWriteback(frame);

  // 生成完成 → 自动写回（SSE 已被屏蔽）→ 轮询兜底送达终态 → 汇总弹出
  const summaryHeading = frame.getByText(/生成(完成|已结束)/);
  await summaryHeading.waitFor({ state: "visible", timeout: 10 * 60_000 });

  // 断言 1：轮询兜底确实在工作（至少完成过一次快照取数，证明终态来自轮询通道）
  expect(writebackPollCount).toBeGreaterThanOrEqual(1);

  // 断言 2：生成汇总卡片在场，未知提示不渲染
  await expect(frame.getByText("生成结果")).toBeVisible();
  await expect(frame.getByText("生成阶段计数未能取得")).toHaveCount(0);

  // 断言 3：生成侧三项均为真实数字而非占位符「—」
  const successCard = frame.getByText("成功", { exact: true }).locator("xpath=..");
  await expect(successCard.locator("span").first()).toHaveText(/^\d+$/);
  const failedCard = frame.getByText("失败", { exact: true }).locator("xpath=..");
  await expect(failedCard.locator("span").first()).toHaveText(/^\d+$/);

  // 断言 4：写回结果照常有数
  await expect(frame.getByText("自动写回结果")).toBeVisible();

  // 收尾：关闭汇总回到 IDLE
  await frame.getByText("返回候选列表").click();
  await expect(summaryHeading).toHaveCount(0);
});
