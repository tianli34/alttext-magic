// server/utils/logger.ts
import { createLogger as sharedCreateLogger, rootLogger } from "../../shared/logger/index.js";
/* ------------------------------------------------------------------ */
/*  代理与重新导出，以保持对旧代码的向后兼容                                   */
/* ------------------------------------------------------------------ */
export const logger = rootLogger;
/**
 * 兼容旧版的创建子 Logger (子日志记录器) 工厂函数
 *
 * @param bindings - 初始绑定的日志上下文或模块名称信息
 */
export function createLogger(bindings) {
    if (typeof bindings === "string") {
        return sharedCreateLogger(bindings);
    }
    const { module, ...rest } = bindings;
    const moduleName = module || "app";
    return sharedCreateLogger(moduleName, rest);
}
const _webhookChild = sharedCreateLogger("webhooks");
/**
 * webhookLogger (网络钩子日志记录器) —— 兼容原有调用方式的门面对象
 */
export const webhookLogger = {
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
     * 需要额外绑定上下文时，可派生新子日志记录器
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
