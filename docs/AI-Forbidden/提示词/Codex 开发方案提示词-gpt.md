

你是一名资深全栈技术负责人兼 Shopify Embedded App 架构师，熟悉 **Node.js、TypeScript、React Router、Prisma、PostgreSQL、Redis、BullMQ、Shopify App Bridge、Polaris、Railway 部署、AI Gateway 集成**，并且擅长**使用 Codex / AI coding agent** 来分阶段落地复杂项目。

我正在开发一个 Shopify Embedded App，项目名为 **AltText Magic**。请你不要只给概念性建议，而是要从“**如何使用 Codex 高效开发这个项目**”的角度，输出一份**可执行、可分阶段推进、适合AI Agent**的实施方案。

---

## 项目背景

**AltText Magic** 是一款面向 Shopify 中小商家的嵌入式 App（Embedded App），通过 AI 在“可控、可审阅”的前提下，批量为店铺四类图片资源补齐缺失的 Alt Text：

1. 产品媒体
2. 文件库
3. 集合封面
4. 文章封面

MVP 必须完整跑通以下闭环：

**扫描 → 生成 → 审阅 → 写回**

并支持以下关键能力：

- 装饰性图片标记
- 共享文件影响范围提示
- Freemium 五档计费
- 超额包
- 付费计划专属增量扫描

---

## 技术栈与部署目标

- Node.js
- TypeScript
- React Router（Web）
- Prisma + PostgreSQL
- Redis + BullMQ
- Shopify App Bridge + Polaris
- AI Gateway（主模型 + 降级模型）
- 部署目标：Railway（web + worker + postgres + redis）

---

## 分阶段计划

### 阶段 1：基础设施与 Shopify App 骨架
核心产出：可部署的空壳 Embedded App

### 阶段 2：数据模型与核心服务层
核心产出：完整 Schema 迁移 + Scope/Mutex/Notice 服务

### 阶段 3：全量扫描管线
核心产出：Bulk 提交 → 流式解析 → Staging → Derive → 原子发布

### 阶段 4：仪表盘、候选列表与装饰性标记
核心产出：Dashboard 分组统计 + 候选展示投影 + 装饰性标记

### 阶段 5：计费与配额系统
核心产出：五档订阅 + 欢迎额度 + Free 月配额 + 超额包 + 额度预留

### 阶段 6：AI 生成管线
核心产出：额度预检 → 线上真值复核 → AI 调用 → 草稿 → 扣费

### 阶段 7：审阅编辑与写回
核心产出：可编辑审阅列表 + 按 alt_plane 路由写回 + 审计

### 阶段 8：增量扫描与 Webhook 驱动
核心产出：Debounce + 四重 Gate + 图片指纹 + 原子 Patch

### 阶段 9：设置、历史记录与运维收尾
核心产出：Settings 页 / History 页 / 清理任务 / GDPR / 可观测性

### 阶段 10：集成测试与上线准备
核心产出：端到端回归 + App Store 提审材料 + FAQ

---

## 你的任务

请围绕“**如何使用 Codex 开发这个项目**”输出一份详细方案


---


