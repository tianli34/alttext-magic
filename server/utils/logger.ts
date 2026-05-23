// server/utils/logger.ts
import { createLogger as sharedCreateLogger, rootLogger, type LogContext, type ExtendedLogger } from "../../shared/logger/index.js";

// 重新导出 ExtendedLogger 类型，供 worker 层引用
export type { ExtendedLogger } from "../../shared/logger/index.js";

/* ------------------------------------------------------------------ */
/*  代理与重新导出，以保持对旧代码的向后兼容                                   */
/* ------------------------------------------------------------------ */

export const logger = rootLogger;

/**
 * 兼容旧版的创建子 Logger (子日志记录器) 工厂函数
 *
 * @param bindings - 初始绑定的日志上下文或模块名称信息
 */
export function createLogger(bindings: Record<string, unknown> | string): ExtendedLogger {
  if (typeof bindings === "string") {
    return sharedCreateLogger(bindings);
  }
  const { module, ...rest } = bindings;
  const moduleName = (module as string) || "app";
  return sharedCreateLogger(moduleName, rest as LogContext);
}

/* ------------------------------------------------------------------ */
/*  webhookLogger —— 保持与原 app/lib/webhook-logger.server.ts 调用签名兼容  */
/* ------------------------------------------------------------------ */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

const _webhookChild = sharedCreateLogger("webhooks");

/**
 * webhookLogger (网络钩子日志记录器) —— 兼容原有调用方式的门面对象
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
   * 需要额外绑定上下文时，可派生新子日志记录器
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