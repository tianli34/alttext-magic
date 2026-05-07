## Task 4.4 — 候选 Usage 详情 API 已完成

### 新建/修改文件

1. **[`server/modules/candidate/candidate-usage.service.ts`](server/modules/candidate/candidate-usage.service.ts)** — 候选 Usage 详情查询服务
   - `listCandidateUsages(shopId, altCandidateId, groupFilter?, dataAccess?)` 核心函数
   - 校验 `altCandidateId` 属于当前 shop（`findFirst` 含 `shopId` 约束）
   - 校验 `alt_target.presentStatus === 'PRESENT'`，NOT_FOUND 时返回空列表
   - 计算 `effectiveReadScopeFlags`，按 scope 过滤 out-of-scope 的 usage
   - 可选 `group` 过滤（`PRODUCT_MEDIA` → PRODUCT，`FILES` → FILE）
   - 每条 usage 返回：`usageType` / `usageId` / `title` / `handle` / `positionIndex` / `currentAlt` / `shopifyAdminUrl`
   - `buildShopifyAdminUrl()`：PRODUCT → `/admin/products/{id}`，FILE → `/admin/settings/files`
   - 可注入 `UsageDetailDataAccess` 接口，便于单测 mock

2. **[`app/routes/api.candidates.$id.usages.tsx`](app/routes/api.candidates.$id.usages.tsx)** — 路由处理器
   - `GET /api/candidates/:altCandidateId/usages?group=PRODUCT_MEDIA`
   - 鉴权 → shop 查找 → 参数校验（zod） → 调用服务 → 返回 JSON

3. **[`tests/candidate-usage.service.test.ts`](tests/candidate-usage.service.test.ts)** — 12 个测试用例全部通过
   - 正常返回 PRODUCT usage + shopifyAdminUrl 拼接
   - out-of-scope FILE usage 被过滤
   - 全 scope 时共享文件同时包含 PRODUCT 和 FILE
   - group 过滤（FILES / PRODUCT_MEDIA / COLLECTION）
   - 候选不存在 → 空列表
   - alt_target NOT_FOUND → 空列表（不查 usages）
   - shop 不存在 → 空列表
   - `buildShopifyAdminUrl` 单元测试
