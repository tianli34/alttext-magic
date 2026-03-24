


# AGENTS.md

## 项目
AltText Magic - Shopify 嵌入式应用

## 当前目标
仅实现第一阶段内容：
- Shopify 嵌入式应用基础框架
- OAuth 安装流程
- Prisma 会话持久化
- shops 数据表初始化
- 加密的离线访问令牌存储
- Webhook 注册功能
- 具备幂等性持久化能力的 Webhook 接收器
- BullMQ 队列 + 工作进程占位代码
- Polaris/App Bridge 占位页面
- 适配 Railway 部署的脚本
- 结构化日志与环境变量校验

## 技术栈
- Node.js
- TypeScript
- Shopify React Router 应用模板
- Prisma + PostgreSQL
- Redis + BullMQ
- Polaris + App Bridge
- Railway 部署平台

## 开发规范

1. 使用 TypeScript 严格模式；避免使用 any。
2. 仅服务端代码放在 `app/lib/server` 目录下。
3. 使用 zod 进行环境变量校验。
4. 使用 pino 实现结构化日志。
5. Webhook HTTP 处理器需保持轻量：
   - 身份验证
   - 幂等持久化
   - 加入队列
   - 快速返回 200
6. Worker 处理实际的 Webhook 逻辑。
7. 暂不实现第二阶段及后续的业务逻辑。
8. 所有函数遵循单一职责。
9.  所有文件遵循单一职责。
10. 在每个文件的开头带上文件名和路径，并用通俗易懂的话说明文件的作用。








