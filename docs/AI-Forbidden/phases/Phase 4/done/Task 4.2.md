Task 4.2 Dashboard 前端页面已完成。以下是变更摘要：

## 新建/修改的文件

### 1. [`app/lib/format.ts`](app/lib/format.ts) — 相对时间格式化工具
- `formatRelativeTime(dateStr)` — ISO 日期字符串 → 中文相对时间（"3 小时前"、"2 天前"等）
- `formatDate(dateStr)` — 日期格式化为 YYYY-MM-DD
- `formatNumber(value)` — 千分位格式化

### 2. [`app/components/dashboard/GroupStatsCard.tsx`](app/components/dashboard/GroupStatsCard.tsx) — 分组统计卡片
- 接收 `GroupStats`（groupType / total / hasAlt / missing / decorative）
- 展示分组图标 + 中文名称 + 总计数量 + hasAlt 覆盖率进度条 + 三项指标（已有/缺失/装饰性）
- 分组标签映射：PRODUCT_MEDIA→商品图片, FILES→文件图片, COLLECTION→合集图片, ARTICLE→文章图片

### 3. [`app/components/dashboard/QuotaSummary.tsx`](app/components/dashboard/QuotaSummary.tsx) — 配额摘要占位
- Phase 4 仅放占位 UI（"当前计划: —"、"剩余额度: —"）
- 提示 Phase 5 接入真实数据

### 4. [`app/components/dashboard/DashboardGrid.module.css`](app/components/dashboard/DashboardGrid.module.css) — 响应式网格
- 桌面端（>768px）：四列 grid
- 平板端（≤768px）：两列
- 手机端（≤480px）：单列

### 5. [`app/routes/app._index.tsx`](app/routes/app._index.tsx) — Dashboard 主页面（重写）
- **Loader**：保留鉴权 + needsNoticeAck 跳转逻辑
- **客户端数据获取**：`fetch GET /api/dashboard` 获取分组统计 + lastPublishedAt + isScanning
- **isScanning 状态提示条**：当 API 返回 `isScanning=true` 时显示 "⏳ 正在重新扫描…" 横幅
- **重新扫描按钮**：调用 `POST /api/scan/start`，按钮切换为 disabled + loading 态（"正在启动扫描…"）
- **lastPublishedAt**：通过 `formatRelativeTime` 展示为相对时间
- **卡片渲染**：仅渲染 API 返回的 groups，out-of-scope 分组不渲染（API 已过滤）
- **轮询刷新**：isScanning 时每 10 秒自动轮询 dashboard API
- **错误处理**：加载骨架屏 + 错误提示 + 重试按钮 + rescan 错误提示

## 验收对照
- ✅ 页面加载后卡片数字与 API 返回一致（直接渲染 `groups` 数组）
- ✅ scope 去掉 Collection 后刷新，Collection 卡片消失（API 层已按 effectiveReadScope 过滤）
- ✅ 点击"重新扫描"后 UI 切换到扫描中状态（按钮 disabled + banner 出现）
- ✅ TypeScript 编译零错误
