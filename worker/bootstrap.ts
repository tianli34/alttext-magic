/**
 * File: worker/bootstrap.ts
 * Purpose: worker 进程启动引导。在导入任何业务模块（含 logger）之前，
 *          为 worker 设置默认的日志文件落盘路径 LOG_FILE，
 *          使 worker 的结构化 JSON 日志同时写入 logs/ 目录，供日志提取脚本逐行解析。
 *
 * 说明：
 * - logger（shared/logger）在模块加载时读取 LOG_FILE 决定是否启用文件落盘，
 *   因此必须在静态 import worker 主体之前完成赋值。此处用动态 import 保证顺序。
 * - 仅 worker 进程走此引导，web 进程不受影响，日志不会泄露到客户端。
 * - 若外部已显式设置 LOG_FILE，则尊重外部配置，不覆盖。
 */
import path from "node:path";

if (!process.env.LOG_FILE) {
  // 默认落盘到项目根 logs/worker.log；logger 使用 pino/file 的 mkdir 选项自动建目录
  process.env.LOG_FILE = path.resolve(process.cwd(), "logs", "worker.log");
}

// 动态导入，确保 LOG_FILE 在 logger 初始化前已就位
await import("./index.js");
