# 目录约束

本项目代码只能放置于以下目录：
- `app/`（前端）、`server/`（服务端业务逻辑）、`worker/`（BullMQ 工作者）
- `shared/`（跨层常量）、`tests/`（测试）、`prisma/`（数据库 schema）
- `scripts/`（工具脚本）、`fixtures/`（测试数据）、`extensions/`（Shopify 扩展）

严禁在 `src/`、`scratch/`、`build/`、`dist-worker/`、`node_modules/` 等非架构目录下创建或修改代码文件。
