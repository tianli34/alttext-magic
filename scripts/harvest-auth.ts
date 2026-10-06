/**
 * File: scripts/harvest-auth.ts
 * Purpose: 从日常 Firefox 收割 Shopify admin 会话，写成 Playwright storageState。
 *
 *          为什么走到这一步（方案演进史，避免重蹈）：
 *          1. 自动化登录：Shopify 风控阻断一切自动化/命令行启动的浏览器
 *             （数百次实测，含真实 Chrome channel + 人工输入），放弃登录路线；
 *          2. Chrome 会话收割：用户日常使用 Firefox，Chrome 配置里没有 admin
 *             会话（实测 cookie 库零 shopify.com）；且 Chrome 136+ 在默认用户
 *             目录下静默忽略 --remote-debugging-port，独立目录又按 Local State
 *             恢复了空的上次 profile，两处都行不通；
 *          3. Firefox 收割（本方案）：Firefox cookie 库为明文 SQLite。复制
 *             cookies.sqlite(+wal/shm) 到独立目录，用 Playwright 自带 Firefox
 *             无头打开副本（WAL 自动重放），读取 *.shopify.com cookie 写入
 *             storageState。全程零登录、零加密破解、只读源库。
 *
 *          隐私边界：仅导出 *.shopify.com 域 cookie；副本目录收割后立即删除；
 *          产物 tests/e2e/.auth/admin.json 已 gitignore；不输出任何 cookie 值。
 *
 *          用法：npx tsx scripts/harvest-auth.ts
 *          Firefox 开着也没关系，脚本每 5 秒复查，退出后自动继续。
 */
import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { firefox } from "@playwright/test";
import { AUTH_STORAGE_STATE } from "../playwright.config";

const FF_ROOT = path.join(process.env["APPDATA"] ?? "", "Mozilla", "Firefox");
/** 副本工作目录（已 gitignore；收割完成后连同 cookie 副本一起删除） */
const FF_PROFILE_COPY_DIR = path.resolve("tests/e2e/.ff-profile");
const SHOPIFY_DOMAIN_SUFFIX = "shopify.com";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isFirefoxRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq firefox.exe" /NH', { encoding: "utf8" });
    return out.includes("firefox.exe");
  } catch {
    return false;
  }
}

/** 解析 profiles.ini，找到当前安装实际使用的默认 profile（[Install*] 段优先） */
function resolveDefaultProfile(): string {
  const iniPath = path.join(FF_ROOT, "profiles.ini");
  if (!existsSync(iniPath)) {
    throw new Error(`找不到 Firefox 配置：${iniPath}（本机似乎没装/没用过 Firefox）`);
  }
  const sections = new Map<string, Record<string, string>>();
  let currentSection = "";
  for (const rawLine of readFileSync(iniPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      sections.set(currentSection, {});
      continue;
    }
    const kvMatch = line.match(/^([^=]+)=(.*)$/);
    const sectionEntries = sections.get(currentSection);
    if (!kvMatch || !sectionEntries) continue;
    sectionEntries[kvMatch[1].trim()] = kvMatch[2].trim();
  }

  // [Install*] 段的 Default 是当前 Firefox 安装实际启动的 profile，
  // 优先级高于 [ProfileN] 里的 Default=1（那只是老的「默认」标记）
  for (const [section, entries] of sections) {
    if (section.startsWith("Install") && entries["Default"]) {
      return entries["Default"];
    }
  }
  for (const [, entries] of sections) {
    if (entries["Path"] && entries["Default"] === "1") {
      return entries["Path"];
    }
  }
  throw new Error("profiles.ini 中没有可用的默认 profile");
}

async function main(): Promise<void> {
  const profileRelPath = resolveDefaultProfile();
  const profileDir = path.join(FF_ROOT, profileRelPath);
  const cookiesSource = path.join(profileDir, "cookies.sqlite");
  if (!existsSync(cookiesSource)) {
    throw new Error(`默认 profile 没有 cookie 库：${cookiesSource}`);
  }
  console.log(`Firefox 默认 profile：${profileRelPath}`);

  // 1. 等待 Firefox 退出（运行中复制有锁与事务一致性问题）
  if (isFirefoxRunning()) {
    console.log("Firefox 正在运行：请完全退出（所有窗口），本脚本将自动继续…");
    while (isFirefoxRunning()) {
      await sleep(5_000);
    }
    await sleep(2_000); // 留出文件锁与 WAL 落盘窗口
  }

  // 2. 复制 cookie 库到独立目录（含 WAL/SHM：最近写入可能还在 WAL 里未合并）
  rmSync(FF_PROFILE_COPY_DIR, { recursive: true, force: true });
  mkdirSync(FF_PROFILE_COPY_DIR, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = cookiesSource + suffix;
    if (existsSync(source)) {
      copyFileSync(source, path.join(FF_PROFILE_COPY_DIR, "cookies.sqlite" + suffix));
    }
  }

  // 3. Playwright Firefox 无头打开副本读取会话
  let context;
  try {
    context = await firefox.launchPersistentContext(FF_PROFILE_COPY_DIR, {
      headless: true,
    });
  } catch (error) {
    throw new Error(
      "Playwright Firefox 启动失败（是否已 npx playwright install firefox？）：" +
        String(error instanceof Error ? error.message : error),
    );
  }

  try {
    const cookies = await context.cookies();
    const shopifyCookies = cookies.filter((cookie) =>
      cookie.domain.endsWith(SHOPIFY_DOMAIN_SUFFIX),
    );
    console.log(
      "shopify.com cookie：",
      shopifyCookies
        .map((cookie) => `${cookie.name}(${cookie.domain})`)
        .join(", ") || "（无）",
    );
    if (shopifyCookies.length === 0) {
      throw new Error(
        "Firefox 默认 profile 里没有 *.shopify.com cookie——" +
          "admin 会话可能不在这个 profile，或浏览器配置了退出即清 cookie。" +
          "请确认日常登录 admin 的就是这套 Firefox profile",
      );
    }

    // 4. 写入 storageState（Playwright Cookie 结构与 storageState 完全兼容）
    mkdirSync(path.dirname(AUTH_STORAGE_STATE), { recursive: true });
    writeFileSync(
      AUTH_STORAGE_STATE,
      JSON.stringify({ cookies: shopifyCookies, origins: [] }, null, 2),
    );
    console.log(
      `已导出 ${shopifyCookies.length} 条 shopify.com cookie → ${AUTH_STORAGE_STATE}`,
    );
  } finally {
    await context.close();
  }

  // 5. 删除副本（内含全部 cookie，不残留）
  rmSync(FF_PROFILE_COPY_DIR, { recursive: true, force: true });
  console.log("cookie 副本已删除");
}

main().catch((error) => {
  console.error("收割失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
