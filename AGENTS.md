# AGENTS.md
项目: Shopify自动生成图片Alt Text应用
技术栈: TS · React Router v7 · Prisma+PG · Redis+BullMQ · Polaris · App Bridge

## 命令

```sh
pnpm dev:all           # 并行启动 Web 开发服务器 + Worker
pnpm dev:web           # 仅 react-router dev（端口 3222）
pnpm dev:worker        # 仅 tsx watch worker
pnpm build             # react-router build（web）
pnpm build:worker      # tsc --project tsconfig.worker.json
pnpm typecheck:full    # typegen → tsc --noEmit
pnpm lint              # eslint .
pnpm format            # prettier --write .
pnpm prisma:generate   # 生成 Prisma client
pnpm prisma:migrate:dev
pnpm prisma:migrate:deploy
pnpm railway:build     # prisma:generate → build → build:worker
pnpm railway:migrate   # prisma:migrate:deploy
node --import tsx tests/<file>.test.ts   # 单个测试
```

`s` 是 pnpm run 的别名, `s dev:all` 等效 `pnpm dev:all`。

## 架构

三层分离:

- `app/` — React Router 前端, 路由定义在 `app/routes/`, 入口 `app/root.tsx`
- `server/` — 服务端业务逻辑: 模块(`server/modules/`), 队列定义(`server/queues/`), AI 网关(`server/ai/`), SSE, 计费
- `worker/` — BullMQ 工作者: `worker/index.ts` 注册 9 个 Worker + 4 个调度器
- `shared/` — 跨层常量
- Prisma 单例: `server/db/prisma.server.ts`, `app/db.server.ts` 仅 re-export
- 双构建目标: web (Vite/RR 打包) + worker (tsc → `dist-worker/`)

## 设置

- Node: `>=20.19 <22 || >=22.12`, 包管理: pnpm, `.npmrc` 含 `engine-strict=true`
- 本地依赖: `docker compose up -d` (PG 18 + Redis 8 + pgAdmin)
- `.env` 从 `.env.example` 复制; 最小必需: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`
- `dev:web` 实际由 `shopify.web.toml` 驱动: predev 自动 `prisma generate`, dev 自动 `prisma migrate deploy`

## 测试

无测试框架; 直接 `node --import tsx` 或 `npx tsx` 执行 `.test.ts` 文件。部分测试依赖本地 Redis 实例运行。

## 工作流限制

- 始前必读: `docs/Specs/tree.txt` & `docs/STATUS.md`
- 按需查阅: 仅限 `docs/Specs/*.md`
- 任务结束: 极简更新（每个任务限 1 行）`docs/STATUS.md`
- 严格纪律: 禁脑补; 须报告文档/代码冲突; 未经明确指示严禁读取其他文档(.md/.txt/.pdf 等)
- 使用技能: 需要读取 schema.prisma 时使用 `pq` 命令 (详见 `.agents/skills/prisma-query/SKILL.md`)

## 编码规范

- 全中文注释/文档; 严格 TS 模式, 禁用 `any`
- 服务端代码必放 `server/*.server.ts`, 严禁泄露至客户端
- 单一职责(文件/函数), 复杂文件加头部说明
- `zod` 校验 env, `pino` 结构化日志
- 禁止代码降级或负优化

## Webhook

- Handler 极简, 仅执行: 鉴权 → 幂等持久化 → 入列 BullMQ → 返 200
- 严禁在 Handler 写业务逻辑, 业务全交由 Worker 异步处理
