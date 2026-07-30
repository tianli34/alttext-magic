/**
 * File: worker/bootstrap.ts
 * Purpose: worker 进程启动引导。在导入任何业务模块之前完成环境准备。
 *
 * 说明：
 * - worker.log 现已不再由全局 logger 落盘（详见 worker/utils/scan-run-logger.ts）。
 *   该文件仅记录「手动触发的扫描链路」，且每次新扫描开始前清空上一次内容，
 *   因此此处不再设置 LOG_FILE，避免全局日志污染 worker.log。
 * - 若外部显式设置 LOG_FILE，则全局日志仍会额外落盘（尊重外部配置）。
 */
// 标记为 ESM 模块，以支持顶层 await
export {};
// 动态导入，确保引导逻辑在 logger 初始化前已就位
await import("./index.js");
