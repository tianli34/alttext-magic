

---

### AltText Magic 开发上下文 (AI专用)

**1. 技术栈**
TS | Node.js | React Router (App Bridge) | Prisma | Postgres | Redis + BullMQ

**2. 核心业务与模型**
*   **闭环：** 全量/增量扫描 -> 额度预留 -> AI 生成 -> 审阅 -> 路由写回。
*   **资源类型：** Product Media, Files, Collection, Article。
*   **数据模型铁律：** 
    *   `alt_candidate`：**唯一写回对象**（业务主键）。
    *   `candidate_group_projection`：**仅用于 UI 分组展示**（同一候选可多处投影）。
    *   `image_usage`：维护图片与资源的关联（支持 sweep 清理）。

**3. 编码红线（必须遵守的业务规则）**
*   **实时真值复核 (CRITICAL)：** 在真正调用 AI 生成前，**必须**从 Shopify 实时读取当前 Alt。若已非空 -> 直接跳过 -> 不调 AI -> 释放预留额度（绝不误扣）。
*   **原子发布 (Atomic Publish)：** 全量扫描必须先写 `staging`/`scan_result`，任务全成功后，单事务**原子覆盖**成功切片的已发布数据（失败切片保留旧数据），绝不能在扫描中途污染前台读取。
*   **店铺互斥锁 (Mutex)：** SCAN（扫描）与 GEN/WRITE（生成/写回）在 Shop 级别严格互斥。Webhook 增量遇到锁必须延迟重试。
*   **严格计费 (Strict Quota)：** 必须先发起 Batch 预留（Reservation），生成成功才扣减。无自动超扣。
*   **边界控制 (Scope)：** `scope_flags` 是最高网关，严格拦截全量扫描任务、前台 UI 展示、Webhook 自动增量。
*   **AI 提示词约束：** 共享文件（Files）若被多处引用，`context_mode` 必须为 `SHARED_NEUTRAL`（中性上下文），禁止生成特定产品描述。