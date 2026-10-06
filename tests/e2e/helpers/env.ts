/**
 * File: tests/e2e/helpers/env.ts
 * Purpose: E2E 环境变量读取与校验（缺失时给出可执行的中文指引，不让测试死在难懂的超时上）。
 */
import "dotenv/config";

/**
 * 嵌入式应用地址。
 * 推荐取法：运行 `shopify app dev` 后按 p 打开预览，复制浏览器地址栏 URL
 * （形如 https://admin.shopify.com/store/<店>/apps/<应用>；复制隧道地址亦可，
 * 打开后会 302 到 admin 嵌入式地址）。
 */
export function getAppUrl(): string {
  const raw = process.env.E2E_APP_URL;
  if (!raw || !raw.startsWith("https://")) {
    throw new Error(
      "缺少 E2E_APP_URL：请在 .env 中配置嵌入式应用地址。" +
        "取法：运行 shopify app dev 后按 p 打开预览，复制浏览器地址栏 URL" +
        "（https://admin.shopify.com/store/<店>/apps/<应用>）",
    );
  }
  return raw;
}
