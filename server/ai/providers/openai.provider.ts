// server/ai/providers/openai.provider.ts
// OpenAI 兼容 Provider — 适配 OpenAI / Azure OpenAI / 任何 OpenAI Chat Completions 兼容端点

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
              text: "请根据图片及上下文信息，输出简洁、描述性的 Alt Text（纯文本，无引号）。",
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.3,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
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
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new AIGenerationError(
          `[${providerName}] 请求超时（${timeoutMs}ms）`,
          err,
        );
      }
      throw new AIGenerationError(
        `[${providerName}] 网络请求失败: ${(err as Error).message}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

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
    };
  }
}

// ----------------------------------------------------------------
// 内部辅助：根据 contextMode 构建 system prompt
// ----------------------------------------------------------------
function buildSystemPrompt(req: GenerateAltRequest): string {
  const contextJson = JSON.stringify(req.contextSnapshot, null, 2);
  return [
    "你是一个专业的 Shopify 电商图片 Alt Text 生成助手。",
    "请根据提供的图片及以下上下文信息，生成准确、简洁、对搜索引擎友好的 Alt Text。",
    `上下文模式：${req.contextMode}`,
    `上下文数据：\n${contextJson}`,
    "规则：",
    "- 纯文本输出，不含引号、前缀或解释",
    "- 不超过 125 个字符",
    "- 包含产品名称、颜色、材质等关键信息（如已知）",
  ].join("\n");
}
