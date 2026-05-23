// shared/logger/index.ts
import pino, { type Logger, type LoggerOptions } from "pino";

/**
 * 结构化日志上下文接口定义
 */
export interface LogContext {
  shop_domain?: string;      // 店铺域名
  batch_id?: string;         // 批次 ID
  alt_plane?: string;        // Alt 平面
  model_used?: string;       // 所用 AI 模型
  context_mode?: string;     // 上下文模式
  duration_ms?: number;      // 持续时间毫秒数
  job_item_id?: string;      // 任务条目 ID
  write_target_id?: string;  // 写回目标 ID
  group_type?: string;       // 分组类型
  error_code?: string;       // 错误代码
  error_message?: string;    // 错误消息
  request_id?: string;       // 请求 ID
  job_name?: string;         // 任务名称
  attempt?: number;          // 重试次数
  module?: string;           // 模块名称
  [key: string]: any;        // 其他可变参数
}

/**
 * 拓展了 withContext 链式派生方法的 Pino Logger 接口
 */
export interface ExtendedLogger extends Logger {
  withContext: (ctx: LogContext) => ExtendedLogger;
}

/**
 * 对原生 Pino Logger 实例进行包装，注入 withContext 方法以支持链式派生 child logger
 */
function wrapLogger(pinoLogger: Logger): ExtendedLogger {
  const extended = pinoLogger as ExtendedLogger;
  extended.withContext = (ctx: LogContext) => {
    return wrapLogger(pinoLogger.child(ctx));
  };
  return extended;
}

const isDev = (process.env.NODE_ENV || "development") === "development";
const logFormat = process.env.LOG_FORMAT || "pretty";
const logLevel = process.env.LOG_LEVEL || "info";

const baseOptions: LoggerOptions = {
  level: logLevel,

  // 为每条日志添加固定字段
  base: {
    app: "shopify-app",
    env: process.env.NODE_ENV || "development",
  },

  // ISO 时间戳
  timestamp: pino.stdTimeFunctions.isoTime,

  // 自定义序列化器
  serializers: {
    req: (req) => ({
      method: req.method,
      url: req.url,
      headers: {
        host: req.headers?.host,
        "user-agent": req.headers?.["user-agent"],
        "x-request-id": req.headers?.["x-request-id"],
      },
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
    err: pino.stdSerializers.err,
  },

  messageKey: "msg",
  errorKey: "err",
};

// 本地开发且非 json 格式时，使用 pino-pretty 进行彩色输出
const transport = (isDev && logFormat !== "json")
  ? {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    }
  : undefined;

/**
 * 根 Logger 实例
 */
export const rootLogger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {}),
});

/**
 * 创建命名子 Logger 工厂函数
 *
 * @param name - 模块或组件名称
 * @param bindings - 初始绑定的日志上下文
 */
export function createLogger(name: string, bindings: LogContext = {}): ExtendedLogger {
  return wrapLogger(rootLogger.child({ module: name, ...bindings }));
}
