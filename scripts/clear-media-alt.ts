/**
 * File: scripts/clear-media-alt.ts
 * Purpose: 批量清空指定店铺全部产品图片(MediaImage)的 alt 文本 —— CLI 入口。
 *
 * 核心逻辑已抽到 server/modules/devtools/clear-media-alt.core.server.ts，
 * 与 Dashboard 上的临时按钮(POST /api/dev/clear-alt/start)共用同一实现，避免逻辑双份。
 * 本文件只负责命令行参数解析、日志回显与进程退出码。
 *
 * 机制(详见 core 模块头部说明):
 *   1. 从 Session 表读取 offline token; 已过期则用 refreshToken 走 OAuth refresh
 *      grant 自动刷新并写回(项目启用了 expiringOfflineAccessTokens)
 *   2. GraphQL 分页遍历 products → media, 收集 alt 非空的 MediaImage
 *   3. 通过 fileUpdate mutation 分批将 alt 置空
 *
 * 用法:
 *   npx tsx scripts/clear-media-alt.ts                     # 预览(dry-run), 不修改
 *   npx tsx scripts/clear-media-alt.ts --apply             # 实际清空
 *   npx tsx scripts/clear-media-alt.ts --shop xxx.myshopify.com --apply
 *   npm run clear:alt -- --apply                           # 同上
 *
 * 安全约定: 默认 dry-run; 只有显式传 --apply 才会发起写操作。
 */
import "dotenv/config";
import prisma from "../server/db/prisma.server";
import { runClearMediaAlt } from "../server/modules/devtools/clear-media-alt.core.server";

// ── 常量 ──────────────────────────────────────────────────────────────
/** 默认目标店铺(开发店) */
const DEFAULT_SHOP = "magic-ai-test-01.myshopify.com";

// ── 参数解析 ──────────────────────────────────────────────────────────
/** 解析命令行参数: --shop <domain> / --apply */
function parseArgs(argv: string[]): { shop: string; apply: boolean } {
  let shop = DEFAULT_SHOP;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--shop") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--shop 需要跟一个店铺域名参数");
      }
      shop = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法: npx tsx scripts/clear-media-alt.ts [--shop <domain>] [--apply]\n" +
          "  默认 dry-run 预览; 传 --apply 才真正清空 alt。",
      );
      process.exit(0);
    }
  }

  return { shop, apply };
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { shop, apply } = parseArgs(process.argv.slice(2));

  const result = await runClearMediaAlt({ shopDomain: shop, apply });

  if (result.failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    console.error("❌ 执行失败:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
