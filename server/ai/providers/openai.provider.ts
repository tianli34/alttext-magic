// server/ai/providers/openai.provider.ts
// OpenAI 兼容 Provider — 适配 OpenAI / Azure OpenAI / 任何 OpenAI Chat Completions 兼容端点

import { AltDraftContextMode } from "@prisma/client";
import type { AIProvider, GenerateAltRequest, GenerateAltResult } from "../ai.types.js";
import { AIGenerationError } from "../ai.types.js";

export interface OpenAIProviderConfig {
  // Provider 标识，用于日志区分主/副
  providerName: string;
  model: string;
  apiKey: string;
  // 自定义端点（Azure / 第三方），默认为 OpenAI 官方
  endpoint?: string;
  timeoutMs: number;
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
  }>;
}

export class OpenAICompatibleProvider implements AIProvider {
  private readonly config: Required<OpenAIProviderConfig>;

  constructor(config: OpenAIProviderConfig) {
    this.config = {
      ...config,
      endpoint: config.endpoint ?? "https://api.openai.com",
    };
  }

  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const { model, apiKey, endpoint, timeoutMs, providerName } = this.config;

    // 构建 prompt
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

    // 整个请求（fetch + 响应体读取）包裹在超时 Promise 中
    const result = await Promise.race<GenerateAltResult>([
      (async () => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body,
        });

        // 5xx 视为可重试失败
        if (response.status >= 500) {
          throw new AIGenerationError(
            `[${providerName}] 服务端错误: HTTP ${response.status}`,
          );
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new AIGenerationError(
            `[${providerName}] 请求失败: HTTP ${response.status} — ${text}`,
          );
        }

        let data: OpenAIChatResponse;
        try {
          data = (await response.json()) as OpenAIChatResponse;
        } catch (err) {
          throw new AIGenerationError(
            `[${providerName}] 响应格式异常（无法解析 JSON）`,
            err,
          );
        }

        const content = data.choices?.[0]?.message?.content;
        if (!content || typeof content !== "string" || content.trim() === "") {
          throw new AIGenerationError(
            `[${providerName}] 响应格式异常（content 为空）`,
          );
        }

        return {
          altText: content.trim(),
          modelUsed: `${providerName}/${model}`,
        } satisfies GenerateAltResult;
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new AIGenerationError(
                `[${providerName}] 请求超时（${timeoutMs}ms）`,
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);

    return result;
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
