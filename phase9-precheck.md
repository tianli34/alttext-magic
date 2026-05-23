# Phase 9 前置预检报告


## Logger 现状

- 现有 Logger: `server/utils/logger.ts` — pino 封装，支持 `createLogger()` 工厂 + child logger
- Web: 尚无 `pino-http` 中间件集成，待 Task 9.7 实现

## 队列现状

### 现有 Queue 名称 (`server/config/queue-names.ts`)

已有 11 个 → 本 Task 新增 3 个：

| 常量 | 队列名 | 状态 |
|------|--------|------|
| `CLEANUP_QUEUE_NAME` | `cleanup` | ✅ 新增 |
| `GDPR_DELETE_QUEUE_NAME` | `gdpr-delete` | ✅ 新增 |
| `LOCK_REAPER_QUEUE_NAME` | `lock-reaper` | ✅ 新增 |

### Queue 定义文件 (`server/queues/`)

| 文件 | 状态 | 内容 |
|------|------|------|
| `cleanup.queue.ts` | ✅ 从空文件改为完整桩 | Queue 实例 + `getCleanupQueue()` + `enqueueCleanup()` |
| `gdpr-delete.queue.ts` | ✅ 从空文件改为完整桩 | Queue 实例 + `getGdprDeleteQueue()` + `enqueueGdprDelete()` |
| `lock-reaper.queue.ts` | ✅ 新建 | Queue 实例 + `getLockReaperQueue()` + `enqueueLockReaper()` |

**备注**: 三个 Queue 均已按 `reservation-reaper.queue.ts` 模式生成完整桩（含 JobData 接口 / 单例 Queue / 入队函数），但：
- 尚无常驻 Worker 注册（待后续 Task 实现）
- 无 Scheduler 注册（需后续 Task 决定是否需要）

### Worker 注册情况 (`worker/index.ts`)

当前已注册 11 个 Worker + 4 个 Scheduler。`cleanup` / `gdpr-delete` / `lock-reaper` 尚未注册到 worker。

