// server/utils/logger.ts
import pino, { type Logger, type LoggerOptions } from "pino";
import { env } from "../config/env.js";

/* ------------------------------------------------------------------ */
/*  基础配置                                                           */
/* ------------------------------------------------------------------ */
const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,

  // 为每条日志添加固定字段
  base: {
    app: "shopify-app",
    env: process.env.NODE_ENV || "development",
  },

  // ISO 时间戳
  timestamp: pino.stdTimeFunctions.isoTime,

  // 自定义序列化器 —— 脱敏 / 规范化
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

/* ------------------------------------------------------------------ */
/*  Transport：开发 pino-pretty / 生产 JSON stdout                     */
/* ------------------------------------------------------------------ */
const isDev = (process.env.NODE_ENV || "development") === "development";

const transport: LoggerOptions["transport"] = isDev
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

/* ------------------------------------------------------------------ */
/*  根 Logger                                                          */
/* ------------------------------------------------------------------ */
export const logger: Logger = pino({
  ...baseOptions,
  ...(transport ? { transport } : {}),
});

/* ------------------------------------------------------------------ */
/*  子 Logger 工厂                                                     */
/* ------------------------------------------------------------------ */

/**
 * 创建子 Logger —— 为不同模块 / 请求绑定上下文字段
 *
 * @example
 *   const log = createLogger({ module: "webhooks" });
 *   log.info({ topic: "orders/create" }, "Webhook received");
 *
 *   const reqLog = createLogger({ requestId: "abc-123", shop: "example.myshopify.com" });
 *   reqLog.info("Processing request");
 */
export function createLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}

/* ------------------------------------------------------------------ */
/*  webhookLogger —— 替代原 app/lib/webhook-logger.server.ts           */
/*  保持相同的调用签名，内部委托给 pino 子 logger                        */
/* ------------------------------------------------------------------ */

/** 与原 webhookLogger payload 类型兼容 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

const _webhookChild = createLogger({ module: "webhooks" });

/**
 * webhookLogger —— 兼容原有调用方式的门面
 *
 * @example
 *   webhookLogger.info("webhook.received", { topic: "orders/create", shop: "x.myshopify.com" });
 *   webhookLogger.error("webhook.processing_failed", { topic: "orders/create", error: "timeout" });
 */
export const webhookLogger = {
  info(event: string, payload?: Record<string, JsonValue>) {
    _webhookChild.info({ event, ...payload }, event);
  },

  warn(event: string, payload?: Record<string, JsonValue>) {
    _webhookChild.warn({ event, ...payload }, event);
  },

  error(event: string, payload?: Record<string, JsonValue>) {
    _webhookChild.error({ event, ...payload }, event);
  },

  /**
   * 需要额外绑定上下文时（如 shop / requestId），可派生新子 logger
   *
   * @example
   *   const shopLog = webhookLogger.child({ shop: "x.myshopify.com" });
   *   shopLog.info("webhook.received", { topic: "orders/create" });
   */
  child(bindings: Record<string, unknown>) {
    const child = _webhookChild.child(bindings);
    return {
      info: (event: string, payload?: Record<string, JsonValue>) =>
        child.info({ event, ...payload }, event),
      warn: (event: string, payload?: Record<string, JsonValue>) =>
        child.warn({ event, ...payload }, event),
      error: (event: string, payload?: Record<string, JsonValue>) =>
        child.error({ event, ...payload }, event),
    };
  },
};