

---

## AltText Magic MVP：AI 编程上下文（极简）

- **项目类型**：Shopify Admin Embedded App；功能闭环：**扫描 → AI生成 → 审阅编辑 → 写回**
- **技术栈**：Node.js + TypeScript + React Router + Prisma + PostgreSQL + Redis + BullMQ + Railway
- **图片类型**：
  - `PRODUCT_MEDIA`
  - `FILES`
  - `COLLECTION_IMAGE`
  - `ARTICLE_IMAGE`

### 核心业务规则
- **首次进入不自动扫描**；必须先展示说明页并确认，然后用户主动开始扫描。
- **shop 级互斥锁**：`SCAN / GENERATE / WRITEBACK` 同时只能有一个运行。
- **scope_flags 闭环**：
  - `scan_scope_flags` = 当前配置
  - `last_published_scope_flags` = 最近一次已发布扫描覆盖范围
  - `effective_read_scope_flags = intersection(scan_scope_flags, last_published_scope_flags)`
  - scope 同时控制：扫描边界、前台展示、生成/写回入口、自动增量刷新
- **仅处理缺失 alt**：`null / "" / 全空白`
- **装饰性图片**可持久化标记；影响统计、生成排除、写回排除，可取消。

### 扫描
- **全量扫描**：用 Shopify GraphQL Bulk，4 类资源分 4 个 task。
- **Bulk 解析**：按 `scan_task_attempt` 隔离；URL 过期/下载失败时只重跑当前 task attempt。
- **全量扫描不直接覆盖线上结果**：先写 `scan_result_*`，完成后**原子发布**到：
  - `alt_target`
  - `image_usage`
  - `alt_candidate`
  - `candidate_group_projection`
- **PARTIAL_SUCCESS**：只替换成功资源类型；失败类型保留上次已发布结果。
- **增量扫描**：仅付费计划启用，MVP 只支持 **产品 / 集合**；通过 **webhook + debounce/coalesce + 图片指纹** 过滤无关变更。

### 去重 / 展示模型
- **唯一写回对象**：candidate 唯一键  
  `(shop_id, alt_plane, write_target_id, locale)`
- 同一 `MediaImage` 可能同时来自 `PRODUCT_MEDIA` 和 `FILES`，但只保留 **1 个 candidate**。
- 关联关系存 `image_usage`；前台按 `candidate_group_projection` 分组展示。
- `FILE_ALT` 是否仍存在，取决于是否还有任一 `PRESENT image_usage`，不能按单个 task 缺席直接判 `NOT_FOUND`。

### AI 生成
- 用户手动触发；只发送**必要图片 URL + 上下文**给 AI；**不落盘原图**。
- 输出要求：**英文、≤125 字符**。
- **调用 AI 前必须实时读取 Shopify 当前 alt 真值**：
  - 若已非空：`SKIPPED_ALREADY_FILLED`
  - **不调用 AI，不扣额度**
- 共享文件上下文模式：
  - `RESOURCE_SPECIFIC`：仅 1 个产品 usage
  - `FILE_NEUTRAL`：仅 1 个文件库 usage
  - `SHARED_NEUTRAL`：多 usage / 混合 usage，**必须使用中性上下文**
- 生成成功才扣额度；失败可重试。

### 审阅 / 写回
- 审阅列表展示：资源名、group、图片位置、共享影响范围、draft、可编辑文本。
- 写回前必须**再次读 Shopify 真值**，避免覆盖外部刚写入的 alt。
- 写回路由：
  - `FILE_ALT` → `fileUpdate`
  - `COLLECTION_IMAGE_ALT` → `collectionUpdate`
  - `ARTICLE_IMAGE_ALT` → `articleUpdate`

### 候选状态（核心）
- `MISSING`
- `GENERATION_FAILED_RETRYABLE`
- `GENERATED`
- `WRITEBACK_FAILED_RETRYABLE`
- `WRITTEN`
- `RESOLVED`
- `NOT_FOUND`
- `DECORATIVE_SKIPPED`
- `SKIPPED_ALREADY_FILLED`

### 计费 / 配额
- **扫描不扣费**
- **成功生成 1 条才扣 1 额度**
- 生成前要做 **credit reservation**
- 无额度绝不调用 AI
- Free：**25/月（UTC自然月）**
- 安装欢迎额度：**50**
- 付费计划支持月付/年付/手动超额包；**不自动超扣**

### 最关键表
- `shops`
- `scan_notice_ack`
- `shop_operation_lock`
- `scan_job / scan_task / scan_task_attempt`
- `scan_result_target / scan_result_usage`
- `alt_target`
- `image_usage`
- `decorative_mark`
- `alt_candidate`
- `candidate_group_projection`
- `alt_draft`
- `audit_log`
- `webhook_event`
- `resource_image_fingerprint`
- `credit_bucket / credit_reservation / credit_ledger`

---


