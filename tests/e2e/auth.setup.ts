/**
 * File: tests/e2e/auth.setup.ts
 * Purpose: 登录态准备——保存 Shopify admin 会话到 storageState，供后续场景复用。
 *
 *          为什么手动登录：admin 登录涉及 2FA/验证码/风控，自动化填表既不可靠
 *          也不该被尝试（历史教训：无头模式干等人工登录 15 分钟超时）。
 *          已有有效登录态时本测试自动通过（日常 headless 路径）；缺失或过期时
 *          等待人工在有头窗口里完成登录（npm run test:e2e:login）。
 *
 *          上下文由 fixture 按项目配置创建（见 playwright.config.ts 的
 *          setupStorageState：无存档时空会话，有存档时带存档），本测试不手动
 *          newContext，避免 storageState 继承行为的歧义。
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "@playwright/test";
import { AUTH_STORAGE_STATE } from "../../playwright.config";
import { getAppUrl } from "./helpers/env";

test("登录 Shopify admin 并保存会话", async ({ page }) => {
  // admin 有两种形态：经典域 myshopify.com/admin 与 admin.shopify.com/store/<店>；
  // 会话 cookie 挂在哪个域取决于用户登录入口，两者都算已登录
  const adminPattern = /(admin\.shopify\.com\/store\/|myshopify\.com\/admin)/;

  // 打开嵌入式应用：会话有效则落到 admin；失效/缺失则 302 到 accounts.shopify.com 登录
  await page.goto(getAppUrl(), { waitUntil: "domcontentloaded" });
  // 鉴权重定向链（oauth/redirect_from_cli 等）需要几次跳转才稳定
  try {
    await page.waitForURL(adminPattern, { timeout: 30_000 });
  } catch {
    // 未在时限内到达 admin → 走人工登录等待
  }

  if (!adminPattern.test(page.url())) {
    console.log(
      "\n[auth] admin 登录态缺失或已过期。" +
        "请在浏览器窗口中手动登录 Shopify admin（含 2FA）；" +
        "登录完成后本测试自动继续并保存会话。若当前是无头运行，请改用 npm run test:e2e:login\n",
    );
    try {
      await page.waitForURL(adminPattern, { timeout: 10 * 60_000 });
    } catch (error) {
      if (page.isClosed()) {
        throw new Error(
          "登录窗口被提前关闭：请重新运行 npm run test:e2e:login，" +
            "完成登录后保持浏览器窗口打开，测试会自动继续",
        );
      }
      throw error;
    }
  }

  // 会话有效（或人工登录完成）：落盘最新登录态
  mkdirSync(dirname(AUTH_STORAGE_STATE), { recursive: true });
  await page.context().storageState({ path: AUTH_STORAGE_STATE });
});
