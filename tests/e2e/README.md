# E2E 测试（Playwright · 真实嵌入式应用）

用真实 Chromium 驱动 admin 后台 iframe 里的真实应用页面，回归「生成阶段计数未能取得」一类
只存在于真实浏览器运行时的缺陷（App Bridge 会话令牌、sessionStorage 恢复路径、SSE 与轮询
双通道时序）。概率竞态通过 `page.route` 故障注入变成每次必现的确定性路径。

## 前提

1. `shopify app dev` 正在运行（隧道可用），开发店已安装应用；
2. 开发店存在**待生成候选**（先在应用内跑一次扫描），且额度充足；
3. `.env` 配置嵌入式应用地址：

```bash
E2E_APP_URL=https://admin.shopify.com/store/<开发店>/apps/<应用>
```

> 取法：运行 `shopify app dev` 后按 `p` 打开预览，复制浏览器地址栏 URL。
> 复制隧道地址（`*.trycloudflare.com`）亦可，打开后会 302 到 admin 嵌入式地址。

## 首次运行（登录态准备：Firefox 会话收割）

admin 登录风控会阻断一切命令行/自动化启动的浏览器（实测数百次），因此**不在任何
自动化环境里登录**。日常浏览器是 Firefox，其 cookie 库为明文 SQLite：

1. 运行 `npx tsx scripts/harvest-auth.ts`（Firefox 开着也没关系，脚本会等你）；
2. **完全退出 Firefox**（所有窗口）；
3. 脚本自动继续：从 profiles.ini 的 `[Install*]` 段定位默认 profile → 复制
   cookies.sqlite(+wal/shm) → Playwright Firefox 无头打开副本 → 只读导出
   `*.shopify.com` cookie 到 `tests/e2e/.auth/admin.json`（已 gitignore）；
4. 副本目录收割后自动删除，Firefox 可照常重新打开。

> 方案演进（避免重蹈）：自动化登录被风控阻断；Chrome 收割两处死点——Chrome 136+
> 默认用户目录静默忽略调试端口，且日常 admin 会话根本不在 Chrome 里。
> 前提：日常在这套 Firefox profile 里登录过 admin。若提示无 shopify.com cookie，
> 说明会话不在此 profile 或配置了退出即清 cookie，届时再用 Cookie-Editor 扩展
> 手动导出。全程零登录动作、只读源库、不输出 cookie 值。

之后日常 `npm run test:e2e` 无头自动复用该登录态；会话过期时重跑上面 1-4 即可。
（`npm run test:e2e:login` 的自动化登录路径保留作备用，但预期会被风控阻断。）

## 运行

```bash
npm run test:e2e          # 无头，setup + 两个场景串行
npm run test:e2e:headed   # 有头，观察真实操作过程
```

## 两个场景覆盖什么

### 场景 1：`tally-recovery.spec.ts` —— 刷新恢复 + 401 竞态注入

复现原缺陷的确定性条件：写回进行中刷新页面（恢复路径直进 WRITEBACK，生成阶段 SSE 不再
激活），且回填首试撞上鉴权竞态。注入 `/api/generation/batch/*` 前两次请求返回 401。

历史实现「单发、失败即放弃」在此概率性留下「生成阶段计数未能取得」；断言回填循环
**重试直至成功**（取数次数 ≥ 3）、汇总三个生成计数均为真实数字、计数回写持久化。

> 为什么篡改 sessionStorage：现行实现在生成完成时会把计数一并持久化，正常刷新不触发
> 回填。抹去 `generationTally` 模拟「未持久化 tally 的旧会话/降级」，才能把回填循环本身
> 置于测试之下。

### 场景 2：`writeback-polling-fallback.spec.ts` —— 写回 SSE 全程中断

Cloudflare 隧道会缓冲 `text/event-stream`，SSE 主通道失效是真实生产条件。注入
`/api/writeback/progress` 连接即中断，写回终态只能由轮询兜底
（`/api/writeback/batch/:batchId`）送达。断言轮询确实工作、汇总由轮询终态组装且
生成侧三项完整（内存 tally 不被破坏）。

## 注意

- **真实消耗**：每个场景各生成 2 张候选的 Alt Text 并写回开发店，消耗对应额度；
  `helpers/generation-flow.ts` 里 `pickCount` 可调。
- **串行**：`workers: 1`，两个场景共享同一开发店数据，禁止并行。
- **时长**：单场景上限 15 分钟（真实 AI 生成 + 写回耗时不可控），实际通常 1-3 分钟。
- **产物**：失败截图/上下文在 `tests/e2e/.artifacts/`（已 gitignore）。
- **选择器**：UI 文案改动（如「生成结果」「Generate」）需同步
  `helpers/generation-flow.ts` 与两个 spec 内的定位器。
