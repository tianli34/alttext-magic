# Phase 9 — 关键指标埋点清单

> 本文档列出所有 `recordMetric` 埋点的指标名称、值类型和标签（tags），方便后续接入 Grafana / Loki 等可观测性平台。

## 全局约定

- 所有指标通过 `recordMetric(name, value, tags)` 记录
- 本质是 `logger.info({ metric: name, value, ...tags })` 结构化日志
- **值类型一律为 `number`**
- **标签命名统一使用 `snake_case`**
- 每条 metric 日志均携带 `shop_domain`（若有上下文）
- 涉及批次的指标携带 `batch_id`

---

## 1. 扫描完成（Scan）

| 指标名 | 值类型 | 含义 | 标签 |
|--------|--------|------|------|
| `scan.rows_total` | `number` | 扫描发布后写入正式表的总 target 行数 | `shop_domain` |
| `scan.rows_missing_alt` | `number` | 缺少 alt text 的 target 行数 | `shop_domain` |

**埋点位置**: `server/modules/scan/catalog/publish.service.ts` — `publishScanResult()` 成功后

---

## 2. AI 生成（Generate）

| 指标名 | 值类型 | 含义 | 标签 |
|--------|--------|------|------|
| `generate.attempt.count` | `1` | 每次 generate-alt job 开始处理时 +1 | `shop_domain`, `batch_id`, `alt_plane` |
| `generate.success` | `1` | 单条候选生成成功 | `shop_domain`, `batch_id`, `model_used`, `context_mode` |
| `generate.fail.{error_code}` | `1` | 单条候选生成失败 | `shop_domain`, `batch_id`, `error_code` |
| `generate.skip.terminal` | `1` | 跳过：候选已处于终态 | `shop_domain`, `batch_id` |
| `generate.skip.non_processable` | `1` | 跳过：候选状态不可处理 | `shop_domain`, `batch_id` |
| `generate.skip.already_filled` | `1` | 跳过：商家已手动填写 alt | `shop_domain`, `batch_id` |

**`generate.fail.*` 常见 error_code**:
- `AIGenerationError` — AI 网关返回错误
- `UNKNOWN_ERROR` — 非 AI 错误兜底

**埋点位置**: `worker/processors/generate-alt.processor.ts` — `processGenerateAltJob()`

---

## 3. 增量扫描（Incremental Scan）

| 指标名 | 值类型 | 含义 | 标签 |
|--------|--------|------|------|
| `incremental.skip.lock_gate` | `1` | 跳过：全量扫描锁占用 | `shop_domain` |
| `incremental.skip.plan` | `1` | 跳过：套餐不支持增量扫描 | `shop_domain` |
| `incremental.skip.scope` | `1` | 跳过：scope 未开启对应资源类型 | `shop_domain` |
| `incremental.skip.no_image_change` | `1` | 跳过：图片指纹未变化 | `shop_domain` |

**埋点位置**:
- `worker/processors/continuous-scan-product.processor.ts`
- `worker/processors/continuous-scan-collection.processor.ts`

---

## 4. 写回（Writeback）

| 指标名 | 值类型 | 含义 | 标签 |
|--------|--------|------|------|
| `writeback.success` | `1` | 单条写回成功 | `shop_domain`, `batch_id` |
| `writeback.fail.WRITEBACK_FAILED` | `1` | 单条写回失败 | `shop_domain`, `batch_id`, `error_code` |
| `writeback.rate` | `0~1` | 批次写回成功率 (success / total) | `shop_domain`, `batch_id`, `total`, `success`, `failed`, `skipped` |

**埋点位置**: `worker/processors/writeback.processor.ts`

---

## 5. 额度预留（Reservation）

| 指标名 | 值类型 | 含义 | 标签 |
|--------|--------|------|------|
| `reservation.acquired` | `1` | 预留创建成功 | `shop_domain`, `batch_id`, `amount` |
| `reservation.released` | `1` | 预留正常释放 | `shop_domain`, `reservation_id` |
| `reservation.expired` | `1` | 预留因超时被 reaper 清理 | `shop_domain`, `reservation_id` |

**埋点位置**: `server/modules/billing/credit/credit-reservation.service.ts`

---

## Grafana 接入建议

### Loki 日志查询示例

```logql
# 扫描行数趋势
{app="shopify-app"} | logfmt | metric="scan.rows_total"

# 生成成功率
{app="shopify-app"} | logfmt | metric="generate.success"
{app="shopify-app"} | logfmt | metric=~"generate.fail..*"

# 写回成功率
{app="shopify-app"} | logfmt | metric="writeback.rate"

# 增量扫描跳过分布
{app="shopify-app"} | logfmt | metric=~"incremental.skip..*"
```

### 指标提取
在 Grafana 中使用 `logfmt` 解析器从 Loki 提取 `metric` 和 `value` 字段，按 `shop_domain` 分组聚合。
