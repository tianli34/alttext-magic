# AGENTS.md
**项目**: Shopify自动生成图片Alt Text应用
**技术栈**: TS, React Router, Prisma+PG, Redis+BullMQ, Polaris+App Bridge

**工作流限制**:
- **始前必读**: `docs/Specs/tree.txt` & `docs/STATUS.md`
- **按需查阅**: 仅限 `docs/Specs/*.md`
- **任务结束**: 极简更新 `docs/STATUS.md`
- **严格纪律**: 禁脑补; 须报告文档/代码冲突; 未经明确指示严禁读取其他文档(.md/.txt/.pdf等)

**编码规范**:
- 全中文注释/文档; 严格TS模式, 禁用 `any`
- 服务端代码必放 `server/*.server.ts`, 严禁泄露至客户端
- 单一职责(文件/函数), 复杂文件加头部说明
- `zod` 校验env, `pino` 结构化日志

**Webhook**:
- Handler极简, 仅执行: 鉴权 -> 幂等持久化 -> 入列BullMQ -> 返200
- 严禁在Handler写业务逻辑, 业务全交由Worker异步处理