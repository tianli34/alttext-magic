// server/ai/providers/openai.provider.ts
// OpenAI 兼容 Provider — 适配 OpenAI / Azure OpenAI / 任何 OpenAI Chat Completions 兼容端点

import { AltDraftContextMode } from "@prisma/client";
import type { AIProvider, GenerateAltRequest, GenerateAltResult, ModelCallRecord } from "../ai.types.js";
import { AIGenerationError } from "../ai.types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger({ module: "openai-provider" });

function localTimestamp(date: Date): string {
  const Y = date.getFullYear();
  const M = String(date.getMonth() + 1).padStart(2, "0");
  const D = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return `${Y}-${M}-${D} ${h}:${m}:${s}.${ms}`;
}

export interface OpenAIProviderConfig {
  providerName: string;
  model: string;
  apiKey: string;
  endpoint?: string;
  timeoutMs: number;
  label: string;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

function classifyNetworkError(err: unknown): "SERVER" | "NON_SERVER" {
  if (err instanceof TypeError) return "NON_SERVER";
  if (err instanceof DOMException && err.name === "TimeoutError") return "SERVER";
  if (err instanceof Error && err.name === "AbortError") return "NON_SERVER";
  return "NON_SERVER";
}

function classifyHttpError(_status: number): "SERVER" | "NON_SERVER" {
  return "SERVER";
}

export class OpenAICompatibleProvider implements AIProvider {
  private readonly config: Required<OpenAIProviderConfig>;

  constructor(config: OpenAIProviderConfig) {
    this.config = {
      ...config,
      endpoint: config.endpoint ?? "https://api.openai.com",
    };
  }

  get modelName(): string {
    return `${this.config.providerName}/${this.config.model}`;
  }

  /** 模型层级标签，如 PRIMARY / 2nd / 3rd / 4th */
  private get tierLabel(): string {
    return this.config.label === "primary" ? "PRIMARY" : this.config.label;
  }

  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const { model, apiKey, endpoint, timeoutMs, providerName } = this.config;

    const systemPrompt = buildSystemPrompt(req);
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
              text: req.locale === "zh-CN"
                ? "请根据图片及上下文信息，输出简洁、描述性的 Alt Text（纯文本，无引号）。"
                : "Based on the image and context, output a concise, descriptive Alt Text (plain text, no quotes).",
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
      const result = await Promise.race<GenerateAltResult>([
        (async (): Promise<GenerateAltResult> => {
          let response: Response;

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
            } finally {
              clearTimeout(timeoutId);
            }
          } catch (err) {
            if (raceSettled) return undefined as unknown as GenerateAltResult;
            const now = Date.now();
            const durationMs = now - start;
            const endStr = localTimestamp(new Date(now));
            log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, err: String(err) }, `[${this.tierLabel}] AI 模型调用失败（网络层）`);
            const failureOrigin = classifyNetworkError(err);
            const record: ModelCallRecord = {
              modelName,
              durationMs,
              status: "FAILED",
              failureOrigin,
              errorMessage: String(err),
            };
            throw new AIGenerationError(
              `[${providerName}] 请求失败: ${err instanceof Error ? err.message : String(err)}`,
              err,
              [record],
            );
          }

          if (!response.ok) {
            if (raceSettled) return undefined as unknown as GenerateAltResult;
            const now = Date.now();
            const durationMs = now - start;
            const endStr = localTimestamp(new Date(now));
            log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, statusCode: response.status }, `[${this.tierLabel}] AI 模型调用失败（HTTP 错误）`);
            const failureOrigin = classifyHttpError(response.status);
            let errorText = "";
            try {
              errorText = await response.text();
            } catch { /* ignore */ }
            const record: ModelCallRecord = {
              modelName,
              durationMs,
              status: "FAILED",
              failureOrigin,
              errorMessage: `HTTP ${response.status}${errorText ? ` — ${errorText}` : ""}`,
            };
            throw new AIGenerationError(
              `[${providerName}] HTTP ${response.status}${errorText ? ` — ${errorText}` : ""}`,
              undefined,
              [record],
            );
          }

          let data: OpenAIChatResponse;
          try {
            data = (await response.json()) as OpenAIChatResponse;
          } catch (err) {
            if (raceSettled) return undefined as unknown as GenerateAltResult;
            const now = Date.now();
            const durationMs = now - start;
            const endStr = localTimestamp(new Date(now));
            log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, reason: "json_parse_error" }, `[${this.tierLabel}] AI 模型调用失败（JSON 解析失败）`);
            const record: ModelCallRecord = {
              modelName,
              durationMs,
              status: "FAILED",
              failureOrigin: "SERVER",
              errorMessage: "响应格式异常（无法解析 JSON）",
            };
            throw new AIGenerationError(
              `[${providerName}] 响应格式异常（无法解析 JSON）`,
              err,
              [record],
            );
          }

          const content = data.choices?.[0]?.message?.content;
          if (!content || typeof content !== "string" || content.trim() === "") {
            if (raceSettled) return undefined as unknown as GenerateAltResult;
            const now = Date.now();
            const durationMs = now - start;
            const endStr = localTimestamp(new Date(now));
            log.warn({ event: "provider.call.failed", modelName, startTime: startStr, endTime: endStr, durationMs, reason: "empty_content" }, `[${this.tierLabel}] AI 模型调用失败（content 为空）`);
            const record: ModelCallRecord = {
              modelName,
              durationMs,
              status: "FAILED",
              failureOrigin: "SERVER",
              errorMessage: "响应格式异常（content 为空）",
            };
            throw new AIGenerationError(
              `[${providerName}] 响应格式异常（content 为空）`,
              undefined,
              [record],
            );
          }

          if (raceSettled) return undefined as unknown as GenerateAltResult;

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
          } satisfies GenerateAltResult;
        })(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => {
              raceSettled = true;
              reject(new AIGenerationError(`[${providerName}] 请求超时（${timeoutMs}ms）`));
            },
            timeoutMs,
          ),
        ),
      ]);

      return result;
    } catch (err) {
      // 内部各分支已记录日志，此处仅确保 AIGenerationError 向上传递
      if (err instanceof AIGenerationError) throw err;
      throw new AIGenerationError(
        `[${providerName}] 请求超时（${timeoutMs}ms）`,
        err,
      );
    }
  }
}

// ----------------------------------------------------------------
// 内部辅助：根据 contextMode 构建 system prompt
// ----------------------------------------------------------------
function contextModeLabel(mode: AltDraftContextMode, locale: "en" | "zh-CN" = "zh-CN"): string {
  if (locale === "en") {
    switch (mode) {
      case AltDraftContextMode.RESOURCE_SPECIFIC:
        return "Specific resource (product/collection/article)";
      case AltDraftContextMode.FILE_NEUTRAL:
        return "File library image, no resource association";
      case AltDraftContextMode.SHARED_NEUTRAL:
        return "Shared across multiple resources";
      default:
        return mode;
    }
  }
  switch (mode) {
    case AltDraftContextMode.RESOURCE_SPECIFIC:
      return "具体资源（产品/集合/文章）";
    case AltDraftContextMode.FILE_NEUTRAL:
      return "文件库图片，无资源关联";
    case AltDraftContextMode.SHARED_NEUTRAL:
      return "跨多个资源共享";
    default:
      return mode;
  }
}

function buildSystemPrompt(req: GenerateAltRequest): string {
  const contextJson = JSON.stringify(req.contextSnapshot, null, 2);

  if (req.locale === "zh-CN") {
    return [
      "你是一个专业的 Shopify 电商图片 Alt Text 生成助手。",
      "请根据提供的图片及以下上下文信息，生成准确、简洁、对搜索引擎友好的 Alt Text。",
      `上下文模式：${contextModeLabel(req.contextMode, "zh-CN")}`,
      `上下文数据：\n${contextJson}`,
      "规则：",
      "- 用中文撰写 Alt Text",
      "- 纯文本输出，不含引号、前缀或解释",
      "- 不超过 75 个汉字",
      "- 包含产品名称、颜色、材质等关键信息（如已知）",
    ].join("\n");
  }

  return [
    "You are an accessibility expert writing alt text for e-commerce images.",
    "Based on the provided image and context, generate accurate, concise, SEO-friendly Alt Text.",
    `Context mode: ${contextModeLabel(req.contextMode, "en")}`,
    `Context data:\n${contextJson}`,
    "Rules:",
    "- Write in English.",
    "- Plain text output, no quotes, prefixes, or explanations.",
    "- Keep it under 125 characters.",
    "- Include product name, color, material if known.",
  ].join("\n");
}
