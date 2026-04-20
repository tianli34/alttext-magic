

---

# 二、顺序任务清单

---

## Task P3-00：Phase 3 基线与契约整理

### 目标
为后续 Agent 提供统一的命名、状态机、fixtures 和调试入口，避免后面边做边改。

### 主要工作
- 定义/确认以下常量或类型：
  - `scan_job.status`
  - `scan_task.status`
  - `scan_task_attempt.status`
  - 资源类型：`PRODUCT_MEDIA / FILES / COLLECTION / ARTICLE`
  - `usage_type`
  - 队列名：`scan_start / parse_bulk_to_staging / derive_scan_attempt_to_result / publish_scan_result`
- 明确 `batchId` 与 `scan_job.id` 的关系  
  - **建议直接统一：`batchId = scan_job.id`**
- 增加本地 fixtures 目录与说明：
  - 4 类脱敏 NDJSON 样本
- 增加统一日志上下文字段：
  - `shopId / scanJobId / scanTaskId / attemptId / resourceType`

### 交付物
- 常量/类型定义文件
- fixtures 目录
- 本地回放说明文档
- 统一日志 helper

### 验收标准
- 后续任务不再重复发明状态名
- 本地可以读取 fixture 做离线调试
- 日志上下文字段统一

### 依赖
- Phase 2 已完成

---

## Task P3-01：首次扫描说明页前端

### 目标
完成首次进入 App 的扫描说明页，允许用户勾选 scope 并开始扫描。

### 主要工作
- 新增扫描说明页路由
- 使用 Polaris 实现：
  - 扫描范围说明
  - 用途说明
  - 留存期限说明
  - AI 边界说明
  - scope 勾选
  - 确认按钮
- 表单校验：
  - 至少选择一个 scope
  - 明确确认说明后才能提交
- 提交后调用 `POST /api/scan/start`
- 成功后跳转扫描进度页

### 交付物
- 说明页 UI
- 与 start API 的前端调用

### 验收标准
- 首次进入可看到说明页
- 未勾选 scope 不能提交
- 提交成功后进入扫描进度页

### 依赖
- P3-00

---

## Task P3-02：`POST /api/scan/start` API

### 目标
实现“开始扫描”的核心入口事务。

### 主要工作
- 新增 `POST /api/scan/start`
- 鉴权：必须是当前 shop 的合法会话
- 输入校验：
  - scope flags
  - ack 参数
- 事务内完成：
  1. 写 `scan_notice_ack`
  2. 更新 `scan_scope_flags`
  3. 获取 `SCAN` 锁
  4. 创建 `scan_job`
  5. 按 scope 创建 `scan_task`
- 初始化 Redis 进度键
- 投递 `scan_start` BullMQ Job
- 若已有扫描锁，占用中则返回 409

### 交付物
- API 实现
- 基础集成测试

### 验收标准
- 成功返回 `scanJobId/batchId`
- 产生对应 `scan_job` 和 `scan_task`
- 扫描锁生效
- 重复启动扫描时返回 409

### 依赖
- P3-00
- P3-01 可先不依赖，前后端可分开验收

---

## Task P3-03：`GET /api/scan/status` 状态 API

### 目标
提供扫描进度页和恢复页面所需的状态读取接口。

### 主要工作
- 新增 `GET /api/scan/status`
- 返回：
  - `scan_job` 总状态
  - task 列表
  - 每个 task 的最新 attempt 状态
  - publish 状态
  - 时间戳字段
  - 可选 Redis 进度摘要
- 支持按 `batchId/scanJobId` 查询
- 统一前端使用的响应结构

### 交付物
- 状态 API
- 响应类型定义

### 验收标准
- 前端刷新页面后可以恢复当前扫描状态
- 任务粒度状态清晰可读

### 依赖
- P3-02

---

## Task P3-04：4 类 Bulk GraphQL 查询定义与真实样本验证

### 目标
完成 Bulk 查询模板，并用真实店铺/样本验证字段正确性。

### 主要工作
- 编写 4 类 Bulk GraphQL 查询：
  - PRODUCT_MEDIA
  - FILES
  - COLLECTION
  - ARTICLE
- 确认字段满足 staging/derive 所需：
  - gid
  - alt
  - image url
  - `__parentId`
  - `position`（如可取）
  - 其他必要标题/handle 等
- 增加本地脚本：
  - 可提交 query 或从 fixture 回放
- 固化脱敏样本

### 交付物
- 4 个 query 模板
- 验证脚本
- 样本文档/截图/fixture

### 验收标准
- 每类 query 均能产出可解析 NDJSON
- 产品媒体的 `__parentId` 可用于关联 Product
- `position` 可读取；若不可用，明确 fallback 方案

### 依赖
- P3-00

---

## Task P3-05：`scan_start` Worker Job 与串行 Bulk 提交

### 目标
实现扫描任务的“逐个 task 串行提交 Bulk”。

### 主要工作
- 实现 `scan_start` BullMQ Job
- 逻辑：
  - 找到当前 `scan_job` 下第一个待提交 task
  - 调用 `bulkOperationRunQuery`
  - 创建 `scan_task_attempt`
  - 记录 Shopify bulk operation id
  - 更新 task / job 状态
- 保证**同一 shop 同时只存在 1 个 running bulk**
- 提供“继续下一个 task”的公共方法，供 webhook 触发

### 交付物
- `scan_start` job
- 提交 Bulk 的 service
- attempt 创建逻辑

### 验收标准
- 对一个 `scan_job`，4 类 task 按顺序提交
- 每个 task 有对应 `scan_task_attempt`
- 日志可追踪到 bulk 提交结果

### 依赖
- P3-02
- P3-04

---

## Task P3-06：`BULK_OPERATIONS_FINISH` Webhook Handler

### 目标
接住 Shopify Bulk 完成通知，并驱动后续解析与下一 task 提交。

### 主要工作
- 新增/完善 `BULK_OPERATIONS_FINISH` webhook handler
- 根据 webhook payload 定位对应 `scan_task_attempt`
- 更新：
  - `bulk_result_url`
  - bulk 完成状态
  - error code / message（若有）
- 若成功：
  - 投递 `parse_bulk_to_staging`
- 无论成功/失败，只要当前 bulk 已终态：
  - 重新投递 `scan_start`，尝试提交下一个 pending task
- 保证幂等

### 交付物
- webhook handler
- 幂等处理
- 集成测试/模拟 payload

### 验收标准
- webhook 到达后能正确关联到 attempt
- 成功时进入 parse 阶段
- 当前 bulk 终态后能继续下一个 task

### 依赖
- P3-05

---

## Task P3-07：流式 NDJSON 解析基础设施

### 目标
先完成通用的“下载 → 流式解析 → 批量 flush”能力。

### 主要工作
- 实现 `parse_bulk_to_staging` Job 的基础流式能力：
  - `fetch(url)`
  - 读取 `ReadableStream`
  - NDJSON 逐行解析
  - 每 500 行 flush 一次
- 禁止整文件读入内存
- 支持 parser callback 模式：
  - 不同资源类型传入不同 row handler
- 对产品媒体支持 `__parentId` 缓存映射的通用机制

### 交付物
- 通用流式 parser
- 通用 batch flush 组件
- fixture 回放入口

### 验收标准
- 使用 fixture 时可稳定逐行解析
- flush 批次可控
- 内存不随文件整体大小线性暴涨

### 依赖
- P3-06

---

## Task P3-08：Staging 写入实现

### 目标
把 4 类 Bulk 数据完整写入 staging 表。

### 主要工作
- 为以下表实现 batch upsert：
  - `stg_product`
  - `stg_media_image_product`
  - `stg_media_image_file`
  - `stg_collection`
  - `stg_article`
- 产品媒体处理：
  - 用 `__parentId` 关联 Product
  - `position_index` 优先使用 Shopify 返回字段
  - 否则按同一 product 下出现顺序补 `0,1,2...`
- parse 成功后更新 attempt 状态，并投递 derive job

### 交付物
- staging writers
- 资源类型专属 row transformer

### 验收标准
- 4 类 staging 表均能落库
- `__parentId` 关联正确
- `position_index` 连续正确

### 依赖
- P3-07

---

## Task P3-09：Bulk URL 过期恢复与 parse 重试

### 目标
实现解析阶段的重试能力，覆盖 Bulk URL 403/过期场景。

### 主要工作
- 在 `parse_bulk_to_staging` 中处理下载失败：
  - 403/404/过期/超时等
- 失败时：
  1. 当前 attempt 标记 FAILED
  2. 创建新 attempt
  3. 重新提交相同 bulk query
- 限制 `max_parse_attempts`
- 超限后：
  - task 标记 FAILED
  - 更新 scan_job 汇总状态（继续等待其他 task）

### 交付物
- parse retry 逻辑
- max attempt 限制
- 异常日志与错误分类

### 验收标准
- 模拟 403 时可自动重新发起 bulk
- 达到上限后 task 进入 FAILED
- 不会无限重试

### 依赖
- P3-08

---

## Task P3-10：`derive_scan_attempt_to_result` Job

### 目标
从 staging 生成待发布结果层：`scan_result_target` / `scan_result_usage`。

### 主要工作
- 实现 derive job
- 针对成功解析的 attempt，从 staging 生成：
  - `scan_result_target`
  - `scan_result_usage`
- 去重规则：
  - 同一 `MediaImage` 来自 `PRODUCT_MEDIA` + `FILES` 时
  - 只保留 **1 条 `FILE_ALT` target**
  - 但保留 **2 条 usage**
- 使用 upsert / conflict key 保证幂等
- task derive 完成后更新状态

### 交付物
- derive job
- dedupe 规则实现
- 关键单元测试

### 验收标准
- 同一 MediaImage 最终只有一条 `FILE_ALT` target
- usage 可同时有 PRODUCT + FILE
- derive 可重复执行且结果稳定

### 依赖
- P3-08
- P3-09

---

## Task P3-11：`publish_scan_result` Job（核心发布与切片替换）

### 目标
实现从结果层原子发布到正式表，且支持“只替换成功切片”。

### 主要工作
- 实现 `publish_scan_result` Job
- 在事务中完成：
  - 将成功 task 对应切片发布到：
    - `alt_target`
    - `image_usage`
- 失败 task 对应切片：
  - 保留旧已发布数据
- 对成功切片做 sweep：
  - `image_usage` 中成功 usage_type 的缺席项标记为 `NOT_FOUND`
- 保证扫描完成前：
  - 前端只读旧已发布数据
  - 不读取 `scan_result_*`

### 交付物
- publish job 核心事务
- 按资源类型切片发布逻辑

### 验收标准
- FULL_SUCCESS 时全部替换
- PARTIAL_SUCCESS 时仅成功切片替换
- 扫描过程中前端不会看到新旧混杂

### 依赖
- P3-10

---

## Task P3-12：发布后收敛逻辑

### 目标
补完 publish 后的业务收敛：FILE_ALT 存在性、candidate 状态、projection、店铺元数据。

### 主要工作
- 基于 `image_usage` 的 PRESENT 集合重算 `FILE_ALT` target 存在性
- candidate 发布收敛：
  - 根据 target 状态
  - decorative_mark
  - draft 状态
  - 派生 `alt_candidate.status`
- 重建 `candidate_group_projection`
  - 覆盖 `FILE_ALT / COLLECTION / ARTICLE`
- 更新店铺字段：
  - `shops.last_published_scope_flags`
  - `shops.last_published_at`
  - `shops.last_published_scan_job_id`
- 最终更新 `scan_job` 为：
  - `SUCCESS / PARTIAL_SUCCESS / FAILED`
- 释放 SCAN 锁

### 交付物
- 发布后收敛逻辑
- projection rebuild 逻辑
- 店铺 publish 元数据更新

### 验收标准
- `FILE_ALT` 是否存在与 usage PRESENT 集合一致
- projection 数据正确生成
- publish 元数据正确更新
- 锁正常释放

### 依赖
- P3-11

---

## Task P3-13：SSE 进度推送 + 扫描进度页前端

### 目标
让前端实时看到扫描进度，并具备刷新恢复能力。

### 主要工作
- Worker 在关键阶段写 Redis：
  - started
  - bulk_submitted
  - bulk_finished
  - parsing
  - derive
  - publish
  - done / failed
- 新增 `GET /api/sse?batchId=...`
  - 从 Redis 读取进度
  - 定时推送 SSE
- 前端扫描进度页：
  - 骨架屏
  - 进度动画
  - “正在扫描您的店铺…”
  - task 粒度状态
  - 异常提示
  - 重新扫描按钮
- 页面刷新后通过 `GET /api/scan/status` 恢复状态

### 交付物
- SSE endpoint
- Redis progress 读写
- 前端进度页

### 验收标准
- 扫描中可看到状态变化
- 刷新页面后可恢复
- 扫描结束后可跳转/展示完成态
- 可触发重新扫描

### 依赖
- P3-03
- P3-12

---

## Task P3-14：全链路验收与回归测试

### 目标
补齐 Phase 3 验收场景，确保可进入 Phase 4。

### 主要工作
- 增加测试/脚本覆盖以下核心场景：
  1. 首次扫描完整闭环
  2. 4 类 Bulk fixture 回放
  3. `__parentId` 关联正确
  4. `position_index` 连续
  5. 同一 MediaImage 合并 target、保留双 usage
  6. Bulk URL 403 自动恢复
  7. 达到 `max_parse_attempts`
  8. `PARTIAL_SUCCESS` 仅替换成功切片
  9. 扫描中前端只读旧数据
  10. `shops.last_published_*` 更新
  11. SCAN 锁期间 generation/start 返回 409
  12. 重新扫描可触发新一轮全量扫描
- 增加本地联调 runbook：
  - tunnel
  - webhook
  - fixture 回放
  - 关键日志查看点

### 交付物
- 回归测试
- 联调文档
- Phase 3 验收清单

### 验收标准
- 与题目中的 10 条验收标准逐项对应
- 本地可稳定复现主链路

### 依赖
- 全部前置任务

---


