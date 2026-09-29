/**
 * 一次性脚本：纠正写回真值复核「自写误判」的被污染记录。
 *
 * 背景（缺陷链）：
 *   audit_log 原有唯一约束 (shop_id, write_target_id, alt_candidate_id) 使同一候选的
 *   第二次写回（清空 Alt → 重扫 → 再写回）必然唯一冲突 → markWritten 事务整体回滚，
 *   但 Shopify fileUpdate 属外部副作用不会撤销 → BullMQ 重试时真值复核读回本次自写的
 *   Alt，判定「商家已手动补 Alt」→ 候选置 RESOLVED、job_item 置 SKIPPED_ALREADY_FILLED、
 *   批次 success 少计、审计行缺失。
 *   迁移 20260929000000_audit_log_append_only 已解除该约束，本脚本修复历史数据。
 *
 * 判定条件（四项全部成立才视为误判，缺一不可，避免误改真实的手动补写）：
 *   1. job_item.status = SKIPPED_ALREADY_FILLED；
 *   2. 本批次内该候选没有任何审计行（说明写回落库被回滚）；
 *   3. 本批次开始之前，同一 (shop_id, write_target_id, alt_candidate_id) 已存在审计行
 *      —— 旧唯一约束在当初必然冲突的硬证据，即该目标此前由本应用写过、本轮是二次写回；
 *   4. alt_target.current_alt_text 与该候选最新草稿文本一致（说明外部写入已生效）。
 *
 * 使用方式：
 *   npx tsx scripts/fix-writeback-false-skip.ts <batchId>            # 预演，只读
 *   npx tsx scripts/fix-writeback-false-skip.ts <batchId> --apply    # 实际修复
 *
 * 注意：审计行为事后重建，写回前原值已不可考（old_alt_text 置 NULL），
 *       written_at 取批次 finished_at（近似真实写入时刻）。
 */
import { randomUUID } from "node:crypto";
import { AltCandidateStatus, AltPlane, JobItemStatus, Prisma } from "@prisma/client";
import prisma from "../server/db/prisma.server";

interface AffectedRow {
  jobItemId: string;
  candidateId: string;
  altTargetId: string;
  writeTargetId: string;
  altPlane: string;
  altDraftId: string | null;
  modelUsed: string | null;
  altText: string;
}

/** 误判记录定位 SQL：batchId 由参数绑定传入 */
function affectedSelectSql(batchId: string): Prisma.Sql {
  return Prisma.sql`
  select
    ji.id                                          as "jobItemId",
    ac.id                                          as "candidateId",
    at_.id                                         as "altTargetId",
    at_.write_target_id                            as "writeTargetId",
    at_.alt_plane::text                            as "altPlane",
    draft.id                                       as "altDraftId",
    draft.model_used::text                         as "modelUsed",
    at_.current_alt_text                           as "altText"
  from job_item ji
  join alt_candidate ac on ac.id = ji.alt_candidate_id
  join alt_target at_ on at_.id = ac.alt_target_id
  join job_batch jb on jb.id = ji.batch_id
  left join lateral (
    select d.id, d.model_used,
           coalesce(d.final_text, d.edited_text, d.generated_text) as text
    from alt_draft d
    where d.alt_candidate_id = ac.id
    order by d.created_at desc
    limit 1
  ) draft on true
  where ji.batch_id = ${batchId}
    and ji.status::text = 'SKIPPED_ALREADY_FILLED'
    and not exists (
      select 1 from audit_log cur
      where cur.job_batch_id = ji.batch_id
        and cur.alt_candidate_id = ji.alt_candidate_id
    )
    and exists (
      select 1 from audit_log prior
      where prior.shop_id = ac.shop_id
        and prior.write_target_id = at_.write_target_id
        and prior.alt_candidate_id = ac.id
        and prior.created_at < jb.started_at
    )
    and draft.text is not null
    and trim(at_.current_alt_text) = trim(draft.text)
  `;
}

function preview(text: string, max = 40): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const apply = flags.includes("--apply");
  const batchId = flags.find((flag) => !flag.startsWith("--"));

  if (!batchId) {
    console.error("用法: npx tsx scripts/fix-writeback-false-skip.ts <batchId> [--apply]");
    process.exitCode = 1;
    return;
  }

  const batch = await prisma.jobBatch.findUnique({ where: { id: batchId } });
  if (!batch) {
    console.error(`批次不存在: ${batchId}`);
    process.exitCode = 1;
    return;
  }

  if (!batch.finishedAt) {
    console.error(`批次 ${batchId} 尚未结束（status=${batch.status}），拒绝修复以免与在途任务竞争`);
    process.exitCode = 1;
    return;
  }

  const rows = await prisma.$queryRaw<AffectedRow[]>(affectedSelectSql(batchId));
  console.log(
    `批次 ${batchId}｜status=${batch.status} total=${batch.total} ` +
      `success=${batch.success} failed=${batch.failed} skipped=${batch.skipped}`,
  );
  console.log(`命中「自写误判」记录：${rows.length} 条`);

  if (rows.length === 0) {
    console.log("无需修复。");
    return;
  }

  for (const row of rows.slice(0, 5)) {
    console.log(`  · 候选 ${row.candidateId}｜${row.writeTargetId}｜${preview(row.altText)}`);
  }
  if (rows.length > 5) console.log(`  … 其余 ${rows.length - 5} 条略`);

  if (!apply) {
    console.log("预演模式：未做任何修改。确认无误后加 --apply 执行修复。");
    return;
  }

  const writtenAt = batch.finishedAt;
  const corrected = await prisma.$transaction(async (tx) => {
    let count = 0;

    for (const row of rows) {
      // 1) job_item：误判「已填充跳过」→ 写回成功
      const item = await tx.jobItem.updateMany({
        where: { id: row.jobItemId, status: JobItemStatus.SKIPPED_ALREADY_FILLED },
        data: { status: JobItemStatus.SUCCESS, error: null },
      });
      if (item.count !== 1) {
        console.warn(`  ! job_item ${row.jobItemId} 状态已变化，整条跳过不改`);
        continue;
      }

      // 2) 候选：RESOLVED（被当作外部已解决）→ WRITTEN，补写回时间
      const candidate = await tx.altCandidate.updateMany({
        where: {
          id: row.candidateId,
          shopId: batch.shopId,
          status: AltCandidateStatus.RESOLVED,
        },
        data: {
          status: AltCandidateStatus.WRITTEN,
          writtenAt,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (candidate.count !== 1) {
        throw new Error(`候选 ${row.candidateId} 状态与预期不符，事务回滚`);
      }

      // 3) 补建缺失的写回审计行（幂等键与线上写回完全一致，重复执行不会重复插入）
      await tx.auditLog.upsert({
        where: { idempotencyKey: `writeback:${batchId}:${row.candidateId}` },
        create: {
          id: randomUUID(),
          shopId: batch.shopId,
          jobBatchId: batchId,
          jobItemId: row.jobItemId,
          altTargetId: row.altTargetId,
          altCandidateId: row.candidateId,
          altDraftId: row.altDraftId,
          idempotencyKey: `writeback:${batchId}:${row.candidateId}`,
          altPlane: row.altPlane as AltPlane,
          writeTargetId: row.writeTargetId,
          // 写回前的原值已不可考（当时随事务回滚丢失），留空而非编造
          oldAltText: null,
          newAltText: row.altText,
          modelUsed: row.modelUsed ?? "unknown",
          writtenAt,
        },
        update: {},
      });

      count += 1;
    }

    if (count > 0) {
      await tx.jobBatch.update({
        where: { id: batchId },
        data: { success: { increment: count }, skipped: { decrement: count } },
      });
    }

    return count;
  });

  console.log(
    `已修复 ${corrected}/${rows.length} 条：job_item→SUCCESS、候选→WRITTEN、` +
      `补建审计行 ${corrected} 条、批次 success+${corrected} / skipped-${corrected}`,
  );

  const remaining = await prisma.$queryRaw<AffectedRow[]>(affectedSelectSql(batchId));
  const after = await prisma.jobBatch.findUnique({ where: { id: batchId } });
  console.log(
    `复核：仍满足误判条件 ${remaining.length} 条（应为 0）｜` +
      `批次现在 success=${after?.success} failed=${after?.failed} skipped=${after?.skipped}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("修复失败，事务已回滚：", error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
