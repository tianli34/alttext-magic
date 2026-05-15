/**
 * File: server/sse/sse.service.ts
 * Purpose: SSE 推送服务。
 *          从 Redis 轮询扫描进度并生成 SSE 事件流。
 *          当进度到达终态（done / failed）或客户端断开时自动停止。
 */
import { getScanProgress } from "./progress-publisher";
import { createLogger } from "../utils/logger";
const logger = createLogger({ module: "sse-service" });
/** SSE 轮询间隔（毫秒） */
const SSE_POLL_INTERVAL_MS = 2000;
/** 终态集合，到达终态后停止轮询 */
const TERMINAL_PHASES = new Set(["done", "failed"]);
/**
 * 启动 SSE 进度推送。
 *
 * 定时从 Redis 读取进度并写入 Response 流。
 * 到达终态或客户端断开时停止。
 *
 * @param scanJobId 扫描任务 ID
 * @param writer WritableStreamDefaultWriter（来自 Response 流）
 * @returns 清理函数，调用可提前停止轮询
 */
export function startSSEProgressStream(scanJobId, writer) {
    let stopped = false;
    const encoder = new TextEncoder();
    /** 写入 SSE 事件到流 */
    async function sendEvent(event) {
        const data = JSON.stringify(event);
        const chunk = encoder.encode(`event: progress\ndata: ${data}\n\n`);
        await writer.write(chunk);
    }
    /** 写入 SSE 心跳（保持连接活跃） */
    async function sendHeartbeat() {
        const chunk = encoder.encode(`:heartbeat\n\n`);
        await writer.write(chunk);
    }
    /** 轮询循环 */
    async function poll() {
        while (!stopped) {
            try {
                const progress = await getScanProgress(scanJobId);
                if (progress) {
                    const event = {
                        type: "progress",
                        completedTasks: progress.completedTasks,
                        totalTasks: progress.totalTasks,
                        status: progress.status,
                        phase: progress.phase,
                        message: progress.message,
                        timestamp: new Date().toISOString(),
                    };
                    await sendEvent(event);
                    // 终态时停止轮询
                    if (TERMINAL_PHASES.has(progress.phase)) {
                        logger.info({ scanJobId, phase: progress.phase }, "SSE stream reached terminal phase, stopping");
                        stopped = true;
                        break;
                    }
                }
                else {
                    // Redis 键已过期或不存在
                    const event = {
                        type: "progress",
                        completedTasks: 0,
                        totalTasks: 0,
                        status: "UNKNOWN",
                        phase: "unknown",
                        message: "进度数据已过期",
                        timestamp: new Date().toISOString(),
                    };
                    await sendEvent(event);
                    stopped = true;
                    break;
                }
            }
            catch (error) {
                logger.error({ scanJobId, error: error instanceof Error ? error.message : String(error) }, "SSE poll error");
            }
            // 等待下一次轮询
            await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
        }
        // 发送关闭事件
        try {
            const closeChunk = encoder.encode(`event: close\ndata: {}\n\n`);
            await writer.write(closeChunk);
            await writer.close();
        }
        catch {
            // 流可能已关闭
        }
    }
    // 启动心跳 + 轮询
    const heartbeatInterval = setInterval(() => {
        if (!stopped) {
            sendHeartbeat().catch(() => {
                stopped = true;
            });
        }
    }, 15000);
    // 启动轮询（不 await）
    poll().finally(() => {
        clearInterval(heartbeatInterval);
    });
    // 返回清理函数
    return () => {
        stopped = true;
        clearInterval(heartbeatInterval);
    };
}
