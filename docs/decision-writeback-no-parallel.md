# 决策记录：为什么存量写回与自动写回无法真正并行

> 结论一句话：同一家店同一时间只允许跑一个写回批次，第二个会被锁拒绝；就算硬放开，工人数量是死的，也不会更快。
>
> 日期：2026-09-17
> 背景：Dashboard 一键处理「待生成（黄）+ 待写回（蓝）」方案讨论
> 决策：采用「先并行启动、被撞掉的一方走重试/扫尾补调」，不做双写回真并行

---

## 一、大白话版本（给所有人看）

想象写回是一家餐厅后厨：

- 不管你下一张大单还是两张小单，后厨永远只有 3 个厨师（默认配置，最多加到 5 个）。
- 你点的每一张图片写回就是一道菜，全都排进同一个取餐口。

一键并行相当于同时下两单：A 单是蓝色存量（以前生成好没写回去的），B 单是黄色刚生成好的（自动写回）。

但后厨还是那 3 个人，不会因为你下了两单就变成 6 个人。实际是两单的菜混在一个队列里轮着做——总量不变，时间不省，还添了三样麻烦（见下文）。

更关键的是：餐厅还有条店规——**一次只接一单**。A 单没做完，B 单直接被门口拦下，单子作废（报错 `WRITEBACK_LOCK_ACTIVE`），B 单的菜就烂在手里，变成新的蓝色。

所以并行启动可以（生成和写回各干各的不拦），但**两个写回并行不行**，后到的那个必被撞掉。

---

## 二、技术原因（给开发看，三条）

### 1. 锁是单 key 的，后到者必被拒绝

- 写回锁是 Redis 单 key：`shop:{shopId}:lock:writeback`，`SET NX PX`，默认 5 分钟。
  - 实现：`server/modules/lock/writeback-lock.service.ts:29-31,80-114`
- `startWriteback` 入口第一行就是检查锁，有锁直接抛错：
  - `server/modules/writeback/writeback.service.ts:109-115` → `WRITEBACK_LOCK_ACTIVE`
- 生成收尾的自动写回走的也是同一个 `startWriteback`，失败只记日志、不重试：
  - `server/modules/generation/generation-batch.service.ts:157-165`（吞错）
  - `triggerAutoWriteback:172-223`（被拒后只回写 `writebackError` 到进度 hash）

时间线：手动写回持有锁跑几分钟 → 生成跑完要自动写回 → 拿锁失败 → 新产出滞留为新蓝色。

### 2. 锁的释放语义容不下两个人

- 每次 `startWriteback` 成功生成一个自己的 `lockId`，塞进该批次每条 job（`writeback.service.ts:190-200`）。
- 批次跑完最后一条 job，用 `lockId` 以 Lua 脚本“对得上才删”放锁（`worker/processors/writeback.processor.ts:242`，`writeback-lock.service.ts:129-139`）。
- 一个 key 只能存一个 `lockId`：先跑完的删不掉（值是别人的）或误删别人的锁，语义直接错乱。要真并行，锁 key 必须按 batch 独立，这是 redesign，不是调参。

### 3. 并行不会更快（工人是死的），反而更危险

- 写回 Worker 是全店共享单池：`worker/index.ts:286-297`，并发度 `WRITEBACK_CONCURRENCY` 默认 3、最大 5（`server/config/env.ts:159-164`）。
- 两批 job 进同一个 BullMQ 队列交错执行，工人不增加，总时长与一个大单基本相同。
- 额外风险：同店 Shopify Admin API mutation 限流加剧、前端 `useGenerationFlow` 只有一个写回槽位、双批次记账对账分裂。
- 数据本身是安全的（`jobItem` 按 `(batchId, candidateId)` 隔离、落库前状态条件写、写前 truth-check 重读），锁防的不是写坏数据，是限流与协调混乱。

---

## 三、相关但不同的撞锁（避免混淆）

| 场景 | 报错 | 说明 |
|---|---|---|
| 双击生成 | `LOCK_CONFLICT (GENERATE)` | PG 一店一行锁，`api.generation.start.tsx:242-259` |
| 扫描中点一键 | `SCAN_LOCK_ACTIVE` | 生成和写回都拒绝 |
| 双击写回 / 手动撞自动 | `WRITEBACK_LOCK_ACTIVE` | 本文档主题 |

注意：`GENERATE`（PG 锁）与 `WRITEBACK`（Redis 锁）互不检查对方，可以并行启动；互斥只发生在写回 vs 写回之间。

---

## 四、后续选项（本次未做）

1. 服务端延迟重试：`triggerAutoWriteback` 撞锁后投递 5 分钟延迟 job 再试一次。
2. 前端扫尾补调：双 SSE 都完成后，若有 `writebackError === WRITEBACK_LOCK_ACTIVE` 则补调一次 `POST /api/writeback/start`。
3. 真并行 redesign：锁 key 按 batch 独立 + 店级 Shopify 节流 + 前端双写回进度位。成本高、收益低，暂不考虑。
4. 提速正道：把 `WRITEBACK_CONCURRENCY` 3 → 5（上限），以及一键前过滤无效候选（无 draft、手填、装饰性），减少排队比加人管用。
