下面给你一个**适合 Codex 执行的 Phase 2 拆解方案**。原则是：**一个任务尽量只完成一个可验证闭环**，避免把“Schema + 服务 + API + 安装逻辑”混在一次提交里。

---

## 先说结论：建议拆成 11 个 Codex 任务

> 推荐粒度：**1 个任务 = 1 个 PR / 1 次 Codex 会话**
>  
> 前提：把完整架构文档（尤其是 **§5.1–5.26** 和 **§6.1**）放进仓库 `docs/`，否则 Codex 很容易自行猜字段名。

---

# 任务列表

## P2-00（可选，但强烈建议）
### 仓库盘点与 Phase 2 差异清单
**目标**
- 让 Codex 先读当前仓库，找出：
  - Prisma schema 现状
  - Shopify 安装/OAuth 回调入口
  - API route 风格
  - service 层组织方式
  - test 运行方式
- 输出一份差异清单，避免后续乱改

**产出**
- `docs/phase-2-gap-checklist.md`

**验收**
- 不改业务逻辑
- 列清楚哪些文件会在 Phase 2 被修改

---

## P2-01
### 领域常量与共享类型
**目标**
先把后续所有服务都要用到的常量/类型收敛好。

**内容**
- 定义默认四类 scope flags：
  - `PRODUCT_MEDIA`
  - `FILES`
  - `COLLECTION_IMAGE`
  - `ARTICLE_IMAGE`
- 定义 `SCAN_NOTICE` 当前版本常量
- 定义锁默认 TTL（30 分钟）、heartbeat 间隔（5 分钟）
- 定义安装初始化额度常量：
  - `WELCOME = 50`
  - `FREE_MONTHLY_INCLUDED = 25`
- 提供 scope flags 校验 / 去重 / 排序工具函数

**建议文件**
- `src/constants/...`
- `src/types/...`
- `src/utils/scopeFlags.ts`

**验收**
- 有单测
- 后续服务不再硬编码这些值

---

## P2-02
### Prisma Schema：补齐 26 张表与关系
**目标**
完成 Phase 2 所需的完整 Prisma schema。

**内容**
- 按架构文档 §5.1–§5.26 补齐所有模型、枚举、关系
- 在字段级注释标明对应架构节号
- 扩展已有 `shops` 表：
  - `scan_scope_flags`：`Json`
  - `last_published_scope_flags`：`Json`
- 为 `scan_notice_ack`、`shop_operation_lock`、`credit_bucket` 等模型补齐字段

**特别要求**
- 不要手工改 DB，只改 Prisma schema
- 尽量与现有 `Shop` 模型兼容，不重建已有基础字段

**验收**
- `prisma format` 通过
- `prisma generate` 通过

> 如果 26 张表太大，建议再拆成：
> - **P2-02a**：shop / plan / credit / lock / notice 相关
> - **P2-02b**：scan / target / candidate / projection / publish 相关

---

## P2-03 7
### 唯一约束、索引与 Migration 生成
**目标**
把 schema 真正落成 migration。

**内容**
- 添加关键唯一约束与索引，至少包括：
  - `alt_target(shop_id, alt_plane, write_target_id, locale)`
  - `alt_candidate(alt_target_id)`
  - `candidate_group_projection(shop_id, group_type, alt_candidate_id)`
  - `credit_bucket(shop_id, bucket_type, cycle_key)`
  - `shop_operation_lock(shop_id)` unique
- 生成 migration
- 增加一个 schema 验证脚本或测试，检查核心表和索引存在

**验收**
- `npx prisma migrate dev` 可执行
- 空库 `npx prisma migrate deploy` 可重放
- 无手工 SQL 修库依赖

---

## P2-04 5
### 安装时初始化：创建两个 credit bucket
**目标**
在 Shopify 安装完成时，同步初始化额度。

**内容**
- 在 OAuth 安装回调 / shop upsert 事务中：
  - 创建店铺记录
  - 创建 `WELCOME(50)`
  - 创建当月 `FREE_MONTHLY_INCLUDED(25)`
- 做成**幂等**
  - 重装/重复回调不能重复插入
- 依赖 `credit_bucket(shop_id, bucket_type, cycle_key)` 唯一约束

**验收**
- 新店安装后有两条 bucket
- 重复安装不重复创建

---

## P2-05 3.5
### `scan_notice_ack` 服务
**目标**
实现“扫描说明确认”基础服务。

**内容**
- `ackNotice(shopId, noticeKey, version, actor...)`
- `getNoticeStatus(shopId, currentVersion)`
- 版本检查逻辑：
  - 无记录 => `needsNoticeAck = true`
  - 旧版本 => `needsNoticeAck = true`
  - 当前版本已确认 => `false`

**验收**
- fresh shop 默认需要确认
- 旧版本确认不会被当成已确认
- 有单测

---

## P2-06 4
### Scope 服务
**目标**
实现 `shops.scan_scope_flags` 的读取、更新和 effective scope 计算。

**内容**
- `getScopeSettings(shopId)`
- `updateScanScopeFlags(shopId, flags)`
- `computeEffectiveReadScopeFlags(scanScopeFlags, grantedReadScopes)`
- 默认值为四类全开
- 更新时：
  - 只改 `scan_scope_flags`
  - **绝不改** `last_published_scope_flags`

**验收**
- 输入非法 flag 会报错
- 更新后 `last_published_scope_flags` 不变
- fresh shop 默认四类全开
- 有单测

---

## P2-07 7.5
### `shop_operation_lock` 服务
**目标**
实现 shop 级互斥锁。

**内容**
- `acquireLock(shopId, operationType, owner...)`
- `releaseLock(shopId, owner...)`
- `heartbeatLock(shopId, owner...)`
- `cleanupExpiredLocks()`
- 采用：
  - `unique(shop_id)`
  - 事务内 `SELECT ... FOR UPDATE`
  - 默认 `expires_at = now + 30min`

**实现建议**
- Prisma 事务 + `queryRaw` / `executeRaw`
- 把 SQL 封在 service 层，不要散落 route 层

**验收**
- acquire -> 再 acquire 冲突
- release 后可重新 acquire
- 超时后 cleanup 可回收
- 有单测/集成测试

---

## P2-08 4
### Bootstrap 聚合服务
**目标**
先做 service，再挂 API。

**内容**
实现 `getBootstrapData(shopId, authContext)`，聚合返回：
- 计划信息占位
- 额度信息占位
- notice 状态
- scope 状态
- 最近扫描状态（无则 `null`）

**注意**
- `effective_read_scope_flags` 为计算值，不入库
- 对 fresh shop：
  - `needsNoticeAck = true`
  - scope 默认四类

**验收**
- fresh shop 返回正确默认态
- 不依赖 Phase 3 数据也能正常返回

---

## P2-09 3
### `POST /api/settings/scope`
**目标**
把 Scope 服务暴露成 API。

**内容**
- 校验登录态 / shop 上下文
- 校验 body 中 flags
- 调用 `updateScanScopeFlags`
- 返回更新后的 scope 状态
- 明确保证不修改 `last_published_scope_flags`

**验收**
- 成功更新 `scan_scope_flags`
- 非法 flag 返回 400
- `last_published_scope_flags` 不变
- 有 API 测试

---

## P2-10 3
### `GET /api/bootstrap`
**目标**
暴露 bootstrap 聚合接口。

**内容**
- 调用 `getBootstrapData`
- 返回 §6.1 约定结构
- 对 fresh shop 返回：
  - `needsNoticeAck: true`
  - 默认四类 scope
  - 最近扫描为空

**验收**
- API 返回结构稳定
- fresh shop 场景通过
- 有 API 测试

---

## P2-11 6.5
### Phase 2 回归测试与文档收口
**目标**
把 Phase 2 的验收标准落成可执行检查。

**内容**
- 补 integration tests / db tests：
  1. migration 可执行
  2. 安装后 2 个 bucket 存在
  3. bootstrap fresh shop 正确
  4. settings/scope 只改 `scan_scope_flags`
  5. lock acquire/conflict/release
  6. lock timeout cleanup
- 更新 README 或 `docs/phase-2.md`
  - 本地启动顺序
  - migrate dev / deploy 验证方式
  - 测试命令

**验收**
- 能映射到你列出的 6 条 Phase 2 验收标准

---

# 推荐执行顺序

```text
P2-00
  -> P2-01
  -> P2-02
  -> P2-03
  -> P2-04
  -> P2-05
  -> P2-06
  -> P2-07
  -> P2-08
  -> P2-09
  -> P2-10
  -> P2-11
```

---

# 给 Codex 的统一任务模板

你每次可以用下面这个模板发给 Codex：

```text
请先阅读以下内容后再动手：
1. docs/architecture.md 中的相关章节：{章节}
2. 当前仓库中相关文件：{文件/目录}
3. 现有测试与 route/service 风格

本次只实现这个任务：{任务名}

要求：
- 只改与本任务直接相关的文件
- 遵循现有代码风格与目录结构
- 不顺手重构无关代码
- 若缺少架构细节，不要猜，先在输出中明确 blocker
- 完成后给出：
  1) 修改的文件列表
  2) 核心实现说明
  3) 测试/命令
  4) 仍需后续任务处理的事项
```

---

# 我建议你实际喂给 Codex 的拆分粒度

如果你想最稳，直接按下面顺序一条条喂：

1. **P2-00 仓库盘点**
2. **P2-01 共享常量与类型**
3. **P2-02 + P2-03 Prisma schema + migration**
4. **P2-04 安装初始化额度**
5. **P2-05 Notice 服务**
6. **P2-06 Scope 服务**
7. **P2-07 Lock 服务**
8. **P2-08 Bootstrap 服务**
9. **P2-09 settings/scope API**
10. **P2-10 bootstrap API**
11. **P2-11 回归测试与文档**

---

如果你愿意，我下一步可以继续帮你把这 11 个任务**直接写成可复制给 Codex 的中文 prompt**。