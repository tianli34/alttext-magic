项目简介
Shopify Admin Embedded App，自动生成图片 Alt Text。
本地开发阶段使用 docker-compose 在本地运行 PostgreSQL 与 Redis 容器，宿主机独立运行 Web 与 Worker 进程，在跑通核心业务闭环后，统一部署到 Railway。

Stack:
- Shopify embedded app
- React Router
- TypeScript
- Prisma + PostgreSQL
- Redis + BullMQ
- Polaris Web Components + App Bridge

读取docs\Specs\tree.txt和docs\STATUS.md，并根据当前任务自行判断需要查阅哪些 Markdown 文档，任务完成后将已完成的工作用最简明扼要的话记录到docs\STATUS.md。
规则：
1. 不要根据没读过的文档脑补；
2. 如果文档之间有冲突，明确指出冲突文件。
3. 如果文档与当前实现有冲突，明确指出冲突。