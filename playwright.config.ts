/**
 * File: playwright.config.ts
 * Purpose: E2E（Playwright）配置——真实浏览器驱动嵌入式应用，回归「生成阶段计数未能取得」。
 *
 *          为什么跑真实嵌入式页面：该缺陷的成因全部位于真实浏览器运行时
 *          （App Bridge 会话令牌、sessionStorage 恢复路径、SSE 与轮询双通道时序），
 *          mock 掉任何一层都会恰好把被测对象 mock 掉。唯一零保真损失的层级是
 *          admin.shopify.com 内 iframe 里的真实应用页面。
 *
 *          概率竞态 → 确定性故障注入：用 page.route 对计数回填/写回 SSE 端点注入
 *          401 / 连接中断，把「刷新后首试撞上令牌竞态」从概率事件变成每次必现的
 *          确定性路径（401 与真实竞态走重试循环同一瞬态分支，非平行实现路径）。
 *
 *          前提：`shopify app dev` 正在运行（隧道可用）、开发店已安装应用且存在
 *          待生成候选、.env 配置 E2E_APP_URL（按 p 打开预览后地址栏里的 URL）。
 */
import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/** 登录态存储文件（已 gitignore：内含 admin 会话 cookie，严禁提交） */
export const AUTH_STORAGE_STATE = "tests/e2e/.auth/admin.json";

// setup 项目的登录态按存档是否存在决定：缺失时必须用空会话内联对象，
// 不能传 undefined（undefined 会被视为「未设置」而继承全局路径，存档
// 不存在时 ENOENT 直接炸在 fixture 创建，连等待人工登录的机会都没有）
const setupStorageState = existsSync(AUTH_STORAGE_STATE)
  ? AUTH_STORAGE_STATE
  : { cookies: [], origins: [] };

export default defineConfig({
  testDir: "tests/e2e",
  // 真实生成 + 自动写回耗时不可控（AI 逐张生成、写回逐条落库），上限放宽到 15 分钟
  timeout: 15 * 60_000,
  expect: { timeout: 20_000 },
  // 两个场景共享同一开发店的数据与额度，必须串行执行
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: "tests/e2e/.artifacts",
  reporter: [["list"]],
  use: {
    // 本机真实 Chrome（而非 Playwright 自带 Chromium）：浏览器指纹更真，
    // 降低 Shopify 登录风控反复弹验证的概率，也更贴近真实运行环境
    channel: "chrome",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    storageState: AUTH_STORAGE_STATE,
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { storageState: setupStorageState },
    },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
});
