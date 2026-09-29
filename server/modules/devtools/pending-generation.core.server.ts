/**
 * File: server/modules/devtools/pending-generation.core.server.ts
 * Purpose: [TEMP-DEVTOOLS] 「待生成生产器」：把当前店铺产品图片造回「待生成」态，便于反复
 *          测试生成链路（与「待写回生产器」= 只清 Shopify alt 的 clear-media-alt 相对）。
 *
 *          两步缺一不可：
 *            1) Shopify 侧：复用 runClearMediaAlt 清空全部产品图片 alt。
 *               只改本地不清 Shopify 的话，下次扫描/增量收敛读到 alt 非空 → 判定 RESOLVED(已有 Alt)。
 *            2) 本地侧：对本次扫到的图片执行 resetTargetsToPendingGeneration
 *               （清 alt 快照 + 删 alt_draft + 候选置 INITIAL）。
 *               只清 Shopify 不改本地的话，草稿仍在 → 收敛成 GENERATED(待写回)，
 *               这正是「待写回生产器」的行为，不是本工具的目标。
 *
 *          产出的「待生成」口径与 dashboard.service 的 pending、
 *          api.dashboard.process 的 generationCandidateIds 完全一致。
 *          范围限制：仅产品图片(FILE_ALT)，集合图/文章图/Files 需另行造数据。
 *
 *          ⚠️ 临时性质: 生产上线前与 server/modules/devtools/ 目录一并删除。
 */
import prisma from "../../db/prisma.server";
import {
  runClearMediaAlt,
  type ClearMediaAltLog,
  type ClearMediaAltResult,
  type ClearMediaAltTokenResolver,
} from "./clear-media-alt.core.server";
import {
  resetTargetsToPendingGeneration,
  type ResetPendingTargetsResult,
} from "./reset-pending-targets.core.server";

export interface ProducePendingGenerationOptions {
  /** 目标店铺域名, 如 xxx.myshopify.com */
  shopDomain: string;
  /** 日志输出回调, 缺省为 console.log */
  log?: ClearMediaAltLog;
  /** 自定义 token 获取方式, 缺省为 Session 表 + refresh grant */
  resolveAccessToken?: ClearMediaAltTokenResolver;
}

export interface ProducePendingGenerationResult {
  /** Shopify 侧清空结果（apply 恒为 true） */
  clear: ClearMediaAltResult;
  /** 本地复位结果; null = 未执行（未扫到图片或店铺不在本地库） */
  reset: ResetPendingTargetsResult | null;
}

/**
 * 执行「待生成生产」。Shopify 清空阶段失败会直接抛错（与 clear-media-alt 一致），
 * 本地阶段的前置条件不满足（无图片/店铺缺失）只记录并跳过，不掩盖已完成的清空动作。
 */
export async function runProducePendingGeneration(
  options: ProducePendingGenerationOptions,
): Promise<ProducePendingGenerationResult> {
  const { shopDomain } = options;
  const log: ClearMediaAltLog = options.log ?? ((line) => console.log(line));

  log(`\n🌱 待生成生产器（清空 Shopify alt + 本地候选复位 INITIAL）`);
  log(`   店铺: ${shopDomain}\n`);

  // 1. Shopify 侧清空, 同时借回调拿到本次扫到的全部产品图片 gid
  const scannedMediaIds: string[] = [];
  const clear = await runClearMediaAlt({
    shopDomain,
    apply: true,
    ...(options.resolveAccessToken
      ? { resolveAccessToken: options.resolveAccessToken }
      : {}),
    log,
    onMediaScanned: (mediaIds) => {
      scannedMediaIds.push(...mediaIds);
    },
  });

  if (clear.failed > 0) {
    log(
      `  ⚠️ 有 ${clear.failed} 张图 Shopify 侧清空失败: 本地仍会复位为待生成, ` +
        `但下次扫描读到非空 alt 会把它们翻回「已有 Alt」, 建议重跑本工具。`,
    );
  }

  if (scannedMediaIds.length === 0) {
    log("  ⚠️ 未扫描到任何产品图片, 跳过本地复位。请确认店铺已有产品与产品图片。");
    return { clear, reset: null };
  }

  // 2. 本地复位
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    select: { id: true },
  });
  if (!shop) {
    log(
      `  ❌ 本地库中不存在店铺 ${shopDomain}, 跳过本地复位` +
        `（Shopify 侧 alt 已清空, 重新扫描后会落到「待写回」而非「待生成」）。`,
    );
    return { clear, reset: null };
  }

  log(`\n♻️ 本地候选复位: 本次扫到产品图片 ${scannedMediaIds.length} 张`);
  const reset = await resetTargetsToPendingGeneration({
    shopId: shop.id,
    writeTargetIds: scannedMediaIds,
    log,
  });

  log(
    `\n🏁 待生成生产完成: 复位候选 ${reset.resetCandidates} 张` +
      `（补建 ${reset.createdCandidates} / 删草稿 ${reset.deletedDrafts}）` +
      ` · 跳过 装饰性 ${reset.skippedDecorative}/生成中 ${reset.skippedGenerating}` +
      ` · 本地无 target ${reset.missingTargets} 张`,
  );
  log(
    `   刷新仪表盘即可在饼图看到「待生成」, 「一键处理」会把它们作为生成候选。`,
  );

  return { clear, reset };
}
