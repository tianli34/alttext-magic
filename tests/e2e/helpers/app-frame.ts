/**
 * File: tests/e2e/helpers/app-frame.ts
 * Purpose: 嵌入式应用的打开与 iframe 解析。
 *
 *          应用运行在 admin.shopify.com 的 iframe 里（App Bridge 嵌入式），
 *          所有按钮/文案定位都必须进入应用 frame；frame 按 URL 特征识别：
 *          React Router 应用路由前缀为 /app，且由隧道域名（非 admin 域）承载。
 *          page.route 注册在 page 层，对本页所有 frame 的请求均生效。
 */
import type { Frame, Page } from "@playwright/test";
import { getAppUrl } from "./env";

/** 应用 frame 的 URL 特征：应用路由前缀 /app 且非 admin 域 */
function isAppFrame(frame: Frame): boolean {
  const url = frame.url();
  return (
    url.startsWith("https://") &&
    !url.includes("admin.shopify.com") &&
    /\/app(\/|\?|$)/.test(url)
  );
}

/** 轮询等待应用 iframe 出现（admin SPA 装配 iframe 需要时间；刷新后 iframe 重建，需重新解析） */
export async function waitForAppFrame(page: Page, timeoutMs = 60_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const frame = page.frames().find(isAppFrame);
    if (frame) return frame;
    if (Date.now() > deadline) {
      const seen = page.frames()
        .map((frame) => frame.url() || "(空)")
        .join(" | ");
      throw new Error(
        `超时未找到应用 iframe（已见 frames：${seen}）。` +
          "请确认 shopify app dev 正在运行，且 E2E_APP_URL 指向嵌入式应用",
      );
    }
    await page.waitForTimeout(500);
  }
}

/** 打开嵌入式应用（等价于终端按 p 打开预览） */
export async function openApp(page: Page): Promise<Frame> {
  await page.goto(getAppUrl(), { waitUntil: "domcontentloaded" });
  return waitForAppFrame(page);
}

/**
 * 应用内导航到候选列表页。
 *
 * s-app-nav 由 App Bridge 渲染进 admin 外壳：frame 内的 s-link 不可点击（上一轮
 * 失败根因），但它携带完整鉴权参数（id_token/hmac/host/shop，token 有效期约 60 秒）。
 * 读取 href 后立即以 frame 导航直达，等价于真人点击导航；对 frame 直接 goto 裸路径
 * 则没有鉴权参数，会触发 /auth/login 弹跳并卡死。
 */
export async function gotoCandidatesPage(frame: Frame): Promise<void> {
  const navLink = frame.getByText("Candidates", { exact: true });
  const href = await navLink.getAttribute("href", { timeout: 20_000 });
  if (!href) {
    throw new Error("应用导航中未找到 Candidates 链接或其 href 为空");
  }
  const target = new URL(href, frame.url()).toString();
  await frame.goto(target, { waitUntil: "domcontentloaded" });
  await frame.waitForURL(/\/app\/candidates/, { timeout: 60_000 });
}
