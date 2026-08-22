修复 SCAN 链路三处职责越界(纯搬迁,不改业务语义):

1. 拆分 scan-start.service.ts 双重职责
   - 新建 server/modules/scan/catalog/bulk-finish.service.ts,迁入 handleBulkOperationsFinishWebhook、payload schema、normalizeBulkTerminalStatus、竞态重试常量及相关依赖注入,沿用 *ServiceDependencies 可测模式
   - webhook-process.service.ts 的 import 改指新文件;更新两个文件的头部注释

2. 补齐 scan-start 的 worker processor 层
   - 新建 worker/processors/scan-start.processor.ts 承接 processScanStartJob(trySubmitNextBatch + 进度阶段更新),从 scan-start.service.ts 删除该函数
   - worker/index.ts 改 import 新 processor,消除跨层 import

3. parse-bulk 失败重试去提交化
   - worker/processors/parse-bulk.processor.ts 重试路径:保留 resetScanTaskToPendingForRetry,改为向 scan-start 队列入列,删除直接 submitTask 调用及其 submitted/slot_exhausted/failed/skipped 分支处理(收敛已由 trySubmitNextBatch 内 reconcileScanJobLifecycle 覆盖)

4. 同步更新 tests/ 中受影响的 import(bulk-operations-finish.webhook.test.ts、parse-bulk.retry.test.ts 等),运行测试与 tsc 构建验证(web + worker 双目标)

不在范围:webhook-event.service.ts 归属调整、continuous-scan processor 编排拆分。