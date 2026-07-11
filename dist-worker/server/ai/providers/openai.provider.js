// server/ai/providers/openai.provider.ts
// OpenAI 兼容 Provider — 适配 OpenAI / Azure OpenAI / 任何 OpenAI Chat Completions 兼容端点
import { AIGenerationError } from "../ai.types.js";
import { createLogger } from "../../utils/logger.js";
import { buildPrompt } from "../prompt-engine.server.js";
const log = createLogger({ module: "openai-provider" });
function localTimestamp(date) {
    const Y = date.getFullYear();
    const M = String(date.getMonth() + 1).padStart(2, "0");
    const D = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}`;
}
function classifyNetworkError(err) {
    if (err instanceof TypeError)
        return "NON_SERVER";
    if (err instanceof DOMException && err.name === "TimeoutError")
        return "SERVER";
    if (err instanceof Error && err.name === "AbortError")
        return "NON_SERVER";
    return "NON_SERVER";
}
function classifyHttpError(_status) {
    return "SERVER";
}
export class OpenAICompatibleProvider {
    config;
    constructor(config) {
        this.config = {
            ...config,
            endpoint: config.endpoint ?? "https://api.openai.com",
        };
    }
    get modelName() {
        return `${this.config.providerName}/${this.config.model}`;
    }
    /** 模型层级标签，如 PRIMARY / 2nd / 3rd / 4th */
    get tierLabel() {
        return this.config.label === "primary" ? "PRIMARY" : this.config.label;
    }
    async generateAlt(req) {
        const { model, apiKey, endpoint, timeoutMs, providerName } = this.config;
        const { systemPrompt, userPrompt } = buildPrompt(req.imageUrl, req.contextSnapshot, req.contextMode, req.locale);
        const url = `${endpoint}/v1/chat/completions`;
        const body = JSON.stringify({
            model,
            messages: [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content: [
                        {
                            type: "image_url",
                            image_url: { url: req.imageUrl, detail: "low" },
                        },
                        {
                            type: "text",
                            text: userPrompt,
                        },
                    ],
                },
            ],
            max_tokens: 300,
            temperature: 0.3,
        });
        const start = Date.now();
        const startStr = localTimestamp(new Date(start));
        const modelName = `${providerName}/${model}`;
        log.info({ event: "provider.call.start", modelName, startTime: startStr }, `[${this.tierLabel}] AI 模型调用开始`);
        let raceSettled = false;
        try {
            // 全部操作（fetch + 响应校验 + response.json()）包裹在 Promise.race 超时中
            // AbortController 仅作最佳努力取消，setTimeout 的 reject 确保超时必定生效
            const result = await Promise.race([
                (async () => {
                    let response;
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
                        try {
                            response = await fetch(url, {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    Authorization: `Bearer ${apiKey}`,
                                },
                                body,
                                signal: controller.signal,
                            });
                        }
                        finally {
                            clearTimeout(timeoutId);
                        }
                    }
                    catch (err) {
                        if (raceSettled)
                            return undefined;
                        const now = Date.now();
                        const durationMs = now - start;
                        const endStr = localTimestamp(new Date(now));
                        log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, err: String(err) }, `[${this.tierLabel}] AI 模型调用失败（网络层）`);
                        const failureOrigin = classifyNetworkError(err);
                        const record = {
                            modelName,
                            durationMs,
                            status: "FAILED",
                            failureOrigin,
                            errorMessage: String(err),
                        };
                        throw new AIGenerationError(`[${providerName}] 请求失败: ${err instanceof Error ? err.message : String(err)}`, err, [record]);
                    }
                    if (!response.ok) {
                        if (raceSettled)
                            return undefined;
                        const now = Date.now();
                        const durationMs = now - start;
                        const endStr = localTimestamp(new Date(now));
                        log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, statusCode: response.status }, `[${this.tierLabel}] AI 模型调用失败（HTTP 错误）`);
                        const failureOrigin = classifyHttpError(response.status);
                        let errorText = "";
                        try {
                            errorText = await response.text();
                        }
                        catch { /* ignore */ }
                        const record = {
                            modelName,
                            durationMs,
                            status: "FAILED",
                            failureOrigin,
                            errorMessage: `HTTP ${response.status}${errorText ? ` — ${errorText}` : ""}`,
                        };
                        throw new AIGenerationError(`[${providerName}] HTTP ${response.status}${errorText ? ` — ${errorText}` : ""}`, undefined, [record]);
                    }
                    let data;
                    try {
                        data = (await response.json());
                    }
                    catch (err) {
                        if (raceSettled)
                            return undefined;
                        const now = Date.now();
                        const durationMs = now - start;
                        const endStr = localTimestamp(new Date(now));
                        log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, reason: "json_parse_error" }, `[${this.tierLabel}] AI 模型调用失败（JSON 解析失败）`);
                        const record = {
                            modelName,
                            durationMs,
                            status: "FAILED",
                            failureOrigin: "SERVER",
                            errorMessage: "响应格式异常（无法解析 JSON）",
                        };
                        throw new AIGenerationError(`[${providerName}] 响应格式异常（无法解析 JSON）`, err, [record]);
                    }
                    const content = data.choices?.[0]?.message?.content;
                    if (!content || typeof content !== "string" || content.trim() === "") {
                        if (raceSettled)
                            return undefined;
                        const now = Date.now();
                        const durationMs = now - start;
                        const endStr = localTimestamp(new Date(now));
                        log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, reason: "empty_content" }, `[${this.tierLabel}] AI 模型调用失败（content 为空）`);
                        const record = {
                            modelName,
                            durationMs,
                            status: "FAILED",
                            failureOrigin: "SERVER",
                            errorMessage: "响应格式异常（content 为空）",
                        };
                        throw new AIGenerationError(`[${providerName}] 响应格式异常（content 为空）`, undefined, [record]);
                    }
                    if (raceSettled)
                        return undefined;
                    const now = Date.now();
                    const durationMs = now - start;
                    const endStr = localTimestamp(new Date(now));
                    log.info({ event: "provider.call.success", modelName, startTime: startStr, endTime: endStr, durationMs }, `[${this.tierLabel}] AI 模型调用成功`);
                    return {
                        altText: content.trim(),
                        modelUsed: modelName,
                        modelCalls: [
                            { modelName, durationMs, status: "SUCCESS" },
                        ],
                    };
                })(),
                new Promise((_, reject) => setTimeout(() => {
                    raceSettled = true;
                    reject(new AIGenerationError(`[${providerName}] 请求超时（${timeoutMs}ms）`));
                }, timeoutMs)),
            ]);
            return result;
        }
        catch (err) {
            // 内部各分支已记录日志，此处仅确保 AIGenerationError 向上传递
            if (err instanceof AIGenerationError)
                throw err;
            throw new AIGenerationError(`[${providerName}] 请求超时（${timeoutMs}ms）`, err);
        }
    }
}
