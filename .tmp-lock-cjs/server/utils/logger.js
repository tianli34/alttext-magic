"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookLogger = exports.logger = void 0;
exports.createLogger = createLogger;
// server/utils/logger.ts
const pino_1 = __importDefault(require("pino"));
const env_js_1 = require("../config/env.js");
/* ------------------------------------------------------------------ */
/*  基础配置                                                           */
/* ------------------------------------------------------------------ */
const baseOptions = {
    level: env_js_1.env.LOG_LEVEL,
    // 为每条日志添加固定字段
    base: {
        app: "shopify-app",
        env: process.env.NODE_ENV || "development",
    },
    // ISO 时间戳
    timestamp: pino_1.default.stdTimeFunctions.isoTime,
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
        err: pino_1.default.stdSerializers.err,
    },
    messageKey: "msg",
    errorKey: "err",
};
/* ------------------------------------------------------------------ */
/*  Transport：开发 pino-pretty / 生产 JSON stdout                     */
/* ------------------------------------------------------------------ */
const isDev = (process.env.NODE_ENV || "development") === "development";
const transport = isDev
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
exports.logger = (0, pino_1.default)({
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
function createLogger(bindings) {
    return exports.logger.child(bindings);
}
const _webhookChild = createLogger({ module: "webhooks" });
/**
 * webhookLogger —— 兼容原有调用方式的门面
 *
 * @example
 *   webhookLogger.info("webhook.received", { topic: "orders/create", shop: "x.myshopify.com" });
 *   webhookLogger.error("webhook.processing_failed", { topic: "orders/create", error: "timeout" });
 */
exports.webhookLogger = {
    info(event, payload) {
        _webhookChild.info({ event, ...payload }, event);
    },
    warn(event, payload) {
        _webhookChild.warn({ event, ...payload }, event);
    },
    error(event, payload) {
        _webhookChild.error({ event, ...payload }, event);
    },
    /**
     * 需要额外绑定上下文时（如 shop / requestId），可派生新子 logger
     *
     * @example
     *   const shopLog = webhookLogger.child({ shop: "x.myshopify.com" });
     *   shopLog.info("webhook.received", { topic: "orders/create" });
     */
    child(bindings) {
        const child = _webhookChild.child(bindings);
        return {
            info: (event, payload) => child.info({ event, ...payload }, event),
            warn: (event, payload) => child.warn({ event, ...payload }, event),
            error: (event, payload) => child.error({ event, ...payload }, event),
        };
    },
};
