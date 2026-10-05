/**
 * File: scripts/_diag-tally-forensics.ts
 * Purpose: 临时诊断脚本（诊断结束即删除，不进入提交）。
 *
 *          要回答的问题只有一个：前端渲染「生成阶段计数未能取得」的那次运行，
 *          服务端侧到底有没有生成批次、计数到了哪个状态、自动写回关联字段是否已落盘。
 *          前端那条提示的充要条件是「构造汇总的 hook 实例从未收到生成终态事件」，
 *          所以服务端现场可以把两种可能区分开：
 *            - DB 里那段时间没有 generation_batch 行 → 该次运行没有生成阶段；
 *            - 有行且终态、Redis 里计数与 writebackBatchId 齐备 → 前端那次是「挂载后接管」。
 *
 *          只读：不做任何写入，仅 SELECT 与 Redis 读取。
 */
import "dotenv/config";
import { Client } from "pg";
import IORedis from "ioredis";

/** 生成进度 hash 的键前缀（与 server/sse/progress-publisher.ts 一致） */
const GENERATION_PROGRESS_KEY_PREFIX = "generation:progress";

/** 逐行打印的对象（截断长字段，避免刷屏） */
function compact(value: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) {
      out[key] = raw;
      continue;
    }
    if (raw instanceof Date) {
      out[key] = raw.toISOString();
      continue;
    }
    if (typeof raw === "object") {
      out[key] = "[object]";
      continue;
    }
    const text = String(raw);
    out[key] = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }
  return JSON.stringify(out);
}

async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });

  await db.connect();

  // 1. 有哪些 batch 相关表（写回批次表名不硬编码）
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name ILIKE '%batch%'
      ORDER BY table_name`,
  );
  console.log("=== TABLES(batch) ===");
  console.log(tables.rows.map((row) => row.table_name).join(", "));

  // 2. 最近的生成批次（计数与终态）
  const batches = await db.query<Record<string, unknown>>(
    `SELECT id, shop_id, status, total_count, completed_count, skipped_count, failed_count,
            created_at, updated_at
       FROM generation_batch
      ORDER BY created_at DESC
      LIMIT 10`,
  );
  console.log("=== RECENT generation_batch ===");
  for (const row of batches.rows) {
    console.log(compact(row));
  }

  // 3. 其他 batch 表最近行（写回批次：用于确认那次运行是否只跑了写回）
  for (const table of tables.rows.map((row) => row.table_name)) {
    if (table === "generation_batch") continue;
    try {
      const rows = await db.query<Record<string, unknown>>(
        `SELECT * FROM "${table}" LIMIT 200`,
      );
      console.log(`=== TABLE ${table} (${rows.rowCount} rows) ===`);
      const sorted = [...rows.rows].sort((a, b) => {
        const left = String(a.created_at ?? a.createdAt ?? "");
        const right = String(b.created_at ?? b.createdAt ?? "");
        return right.localeCompare(left);
      });
      for (const row of sorted.slice(0, 6)) {
        console.log(compact(row));
      }
    } catch (error) {
      console.log(`=== TABLE ${table} FAILED: ${String(error)} ===`);
    }
  }

  // 4. Redis 生成进度 hash：计数 + 自动写回关联字段 + TTL
  const redis = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, chunk] = await redis.scan(
      cursor,
      "MATCH",
      `${GENERATION_PROGRESS_KEY_PREFIX}:*`,
      "COUNT",
      200,
    );
    cursor = next;
    keys.push(...chunk);
  } while (cursor !== "0");

  console.log(`=== REDIS ${GENERATION_PROGRESS_KEY_PREFIX}:* (${keys.length} keys) ===`);
  keys.sort();
  for (const key of keys) {
    const hash = await redis.hgetall(key);
    const ttl = await redis.ttl(key);
    console.log(compact({ key, ttl, ...hash }));
  }

  redis.disconnect();
  await db.end();
}

main().catch((error) => {
  console.error("FORENSICS FAILED:", error);
  process.exitCode = 1;
});
