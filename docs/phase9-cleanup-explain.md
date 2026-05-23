# Phase 9 — Cleanup Job SQL EXPLAIN 分析

> 以下为各 cleanup 子任务 SQL 的索引覆盖分析与预期 EXPLAIN 结果。
> 索引名称基于 Prisma `@@index` 生成的 PostgreSQL 命名规范：`<table>_<columns>_idx`。
> **环境**: PostgreSQL 18, Prisma ORM, `CONCURRENTLY` 创建索引。

---

## 1. cleanupAltDraft — 清理过期 AltDraft

### SQL

```sql
DELETE FROM alt_draft WHERE id IN (
  SELECT id FROM alt_draft WHERE expires_at < NOW() LIMIT 1000
)
```

### 可用索引

| 索引 | 列 | 来源 |
|------|-----|------|
| `alt_draft_expires_at_idx` | `expires_at` | schema.prisma `@@index([expiresAt])` |
| `alt_draft_shop_id_expires_at_idx` | `shop_id, expires_at` | schema.prisma `@@index([shopId, expiresAt])` |

### 预期 EXPLAIN

```
Delete on alt_draft
  ->  Hash Join
        Hash Cond: (alt_draft.id = sub.id)
        ->  Seq Scan on alt_draft
        ->  Hash
              ->  Subquery Scan on sub
                    ->  Limit
                          ->  Index Scan using alt_draft_expires_at_idx on alt_draft
                                Index Cond: (expires_at < now())
```

### 结论

✅ 子查询直接命中 `alt_draft_expires_at_idx`，`Index Scan` 范围扫描 `expires_at < NOW()` 后 `LIMIT 1000` 截断，效率最优。

---

## 2. cleanupAuditLog — 清理 90 天前的审计日志

### SQL

```sql
DELETE FROM audit_log WHERE id IN (
  SELECT id FROM audit_log
  WHERE created_at < NOW() - interval '90 days'
  LIMIT 1000
)
```

### 可用索引

| 索引 | 列 | 来源 |
|------|-----|------|
| `audit_log_created_at_idx` | `created_at` | **本次 migration 新增** |

### 预期 EXPLAIN

```
Delete on audit_log
  ->  Hash Join
        Hash Cond: (audit_log.id = sub.id)
        ->  Seq Scan on audit_log
        ->  Hash
              ->  Subquery Scan on sub
                    ->  Limit
                          ->  Index Scan using audit_log_created_at_idx on audit_log
                                Index Cond: (created_at < (now() - '90 days'::interval))
```

### 结论

✅ 依赖本次 migration 新增的 `audit_log_created_at_idx`，子查询走 `Index Scan` 范围扫描，避免全表扫描。

---

## 3. cleanupStaging — 清理 staging 表（stg_* ）

### SQL（以 stg_product 为例）

```sql
DELETE FROM stg_product WHERE id IN (
  SELECT sp.id FROM stg_product sp
  JOIN scan_task_attempt sta ON sp.scan_task_attempt_id = sta.id
  WHERE sta.status IN ('SUCCESS','FAILED')
    AND sta.started_at < NOW() - interval '7 days'
  LIMIT 1000
)
```

### 可用索引

**stg_product 侧**:

| 索引 | 列 | 来源 |
|------|-----|------|
| `stg_product_scan_task_attempt_id_idx` | `scan_task_attempt_id` | schema.prisma `@@index([scanTaskAttemptId])` |

**scan_task_attempt 侧**:

| 索引 | 列 | 来源 |
|------|-----|------|
| `scan_task_attempt_shop_id_status_started_at_idx` | `shop_id, status, started_at` | schema.prisma `@@index([shopId, status, startedAt])` |
| `scan_task_attempt_scan_task_id_status_idx` | `scan_task_id, status` | schema.prisma `@@index([scanTaskId, status])` |

### 预期 EXPLAIN

```
Delete on stg_product
  ->  Hash Join
        Hash Cond: (stg_product.id = sub.id)
        ->  Seq Scan on stg_product
        ->  Hash
              ->  Subquery Scan on sub
                    ->  Limit
                          ->  Nested Loop
                                ->  Index Scan using scan_task_attempt_shop_id_status_started_at_idx
                                      Index Cond: (status = ANY('{SUCCESS,FAILED}'))
                                      Filter: (started_at < (now() - '7 days'::interval))
                                ->  Index Scan using stg_product_scan_task_attempt_id_idx
                                      Index Cond: (scan_task_attempt_id = sta.id)
```

### 分析

- `scan_task_attempt` 的复合索引 `(shop_id, status, started_at)` 在本查询中缺少 `shop_id` 前缀列，PG 可能退化为 `Filter` 模式或在 `status` 列做 `IN` 过滤。
- `stg_product` 侧通过 `scan_task_attempt_id_idx` 做 `Nested Loop` 的内表查找，效率良好。
- 5 个 stg_* 表共享相同的索引结构（均有 `scan_task_attempt_id` 索引），EXPLAIN 行为一致。

### 结论

⚠️ 子查询中 `scan_task_attempt` 的过滤未完全命中复合索引前缀（缺少 `shop_id`），但 cleanup 为低频操作（每日一次），且 `LIMIT 1000` 控制了每次扫描量。可接受的权衡。

---

## 4. cleanupStaging — 清理 scan_result_usage / scan_result_target

### SQL（以 scan_result_usage 为例）

```sql
DELETE FROM scan_result_usage WHERE id IN (
  SELECT id FROM scan_result_usage WHERE scan_job_id IN (
    SELECT sj.id FROM scan_job sj
    WHERE sj.status IN ('SUCCESS','PARTIAL_SUCCESS','FAILED')
      AND sj.finished_at IS NOT NULL
      AND sj.finished_at < NOW() - interval '7 days'
  ) LIMIT 1000
)
```

### 可用索引

**scan_result_usage 侧**:

| 索引 | 列 | 来源 |
|------|-----|------|
| `scan_result_usage_scan_job_id_idx` | `scan_job_id` | schema.prisma `@@index([scanJobId])` |

**scan_job 侧**:

| 索引 | 列 | 来源 |
|------|-----|------|
| `scan_job_shop_id_status_started_at_idx` | `shop_id, status, started_at` | schema.prisma `@@index([shopId, status, startedAt])` |

### 预期 EXPLAIN

```
Delete on scan_result_usage
  ->  Hash Join
        Hash Cond: (scan_result_usage.id = sub.id)
        ->  Seq Scan on scan_result_usage
        ->  Hash
              ->  Subquery Scan on sub
                    ->  Limit
                          ->  Hash Semi Join
                                Hash Cond: (scan_result_usage.scan_job_id = sj.id)
                                ->  Index Scan using scan_result_usage_pkey on scan_result_usage
                                ->  Hash
                                      ->  Seq Scan on scan_job sj
                                            Filter: (status = ANY('{SUCCESS,PARTIAL_SUCCESS,FAILED}')
                                              AND finished_at IS NOT NULL
                                              AND finished_at < (now() - '7 days'::interval))
```

### 分析

- `scan_job` 无 `finished_at` 单列索引，子查询对 `scan_job` 可能走 `Seq Scan` + `Filter`。
- `scan_result_usage` 通过 `scan_job_id_idx` 做 `Semi Join`，限制删除范围。
- 先删 `scan_result_usage`（被 `scan_result_target` FK 引用），再删 `scan_result_target`，保证 FK 完整性。

### 结论

⚠️ `scan_job` 无 `(status, finished_at)` 专用索引，cleanup 低频且 PG `Seq Scan` 对中小表效率足够。可接受的权衡。

---

## 5. cleanupFailedAttempt — 清理失败 ScanTaskAttempt

### SQL

```sql
DELETE FROM scan_task_attempt WHERE id IN (
  SELECT id FROM scan_task_attempt
  WHERE status = 'FAILED'
    AND started_at < NOW() - interval '7 days'
  LIMIT 1000
)
```

### 可用索引

| 索引 | 列 | 来源 |
|------|-----|------|
| `scan_task_attempt_shop_id_status_started_at_idx` | `shop_id, status, started_at` | schema.prisma `@@index([shopId, status, startedAt])` |

### 预期 EXPLAIN

```
Delete on scan_task_attempt
  ->  Hash Join
        Hash Cond: (scan_task_attempt.id = sub.id)
        ->  Seq Scan on scan_task_attempt
        ->  Hash
              ->  Subquery Scan on sub
                    ->  Limit
                          ->  Seq Scan on scan_task_attempt
                                Filter: (status = 'FAILED'
                                  AND started_at < (now() - '7 days'::interval))
```

### 分析

- 复合索引 `(shop_id, status, started_at)` 的前缀 `shop_id` 未出现在 WHERE 中，PG 无法直接利用该索引。
- 但 `FAILED` 状态的 attempt 数量通常很少，`Seq Scan` + `Filter` + `LIMIT 1000` 在实际数据量下性能可接受。
- FK CASCADE 自动清理关联的 `stg_*` 行。

### 结论

⚠️ 无专用 `(status, started_at)` 索引，依赖 `Seq Scan` 过滤。cleanup 每日一次 + `LIMIT 1000`，可接受的权衡。如需优化可后续添加 `@@index([status, startedAt])`。

---

## 6. cleanupWebhookEvent — 清理已处理 Webhook 事件

### SQL

```sql
DELETE FROM webhook_events WHERE id IN (
  SELECT id FROM webhook_events
  WHERE processed_at IS NOT NULL
    AND created_at < NOW() - interval '7 days'
  LIMIT 1000
)
```

### 可用索引

| 索引 | 列 | 来源 |
|------|-----|------|
| `webhook_events_created_at_idx` | `created_at` | **本次 migration 新增** |
| `webhook_events_processed_at_idx` | `processed_at` | schema.prisma 已有 |

### 预期 EXPLAIN

```
Delete on webhook_events
  ->  Hash Join
        Hash Cond: (webhook_events.id = sub.id)
        ->  Seq Scan on webhook_events
        ->  Hash
              ->  Subquery Scan on sub
                    ->  Limit
                          ->  Index Scan using webhook_events_created_at_idx on webhook_events
                                Index Cond: (created_at < (now() - '7 days'::interval))
                                Filter: (processed_at IS NOT NULL)
```

### 结论

✅ 子查询走 `webhook_events_created_at_idx`（本次新增）做 `Index Scan` 范围扫描，`processed_at IS NOT NULL` 作为 `Filter` 条件叠加过滤。已处理事件通常占绝大多数，`Filter` 选择性高。

---

## 索引总览

| 子任务 | 核心索引 | 类型 | 新增 |
|--------|----------|------|------|
| cleanupAltDraft | `alt_draft_expires_at_idx` | 范围扫描 | ❌ 已有 |
| cleanupAuditLog | `audit_log_created_at_idx` | 范围扫描 | ✅ 本次新增 |
| cleanupStaging (stg_*) | `stg_*_scan_task_attempt_id_idx` + 复合索引 | JOIN + 过滤 | ❌ 已有 |
| cleanupStaging (scan_result) | `scan_result_*_scan_job_id_idx` | Semi Join | ❌ 已有 |
| cleanupFailedAttempt | `scan_task_attempt复合索引` (非最优) | Seq Scan + Filter | ❌ 已有 |
| cleanupWebhookEvent | `webhook_events_created_at_idx` | 范围扫描 | ✅ 本次新增 |

---

## Migration: `20260524080000_add_cleanup_indexes`

```sql
-- 新增两个索引，支持 cleanup job 高效范围扫描
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS webhook_events_created_at_idx ON webhook_events (created_at);
```

`CONCURRENTLY` 保证不锁表，线上安全执行。
