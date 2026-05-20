// server/ai/providers/gemini.provider.ts
// Gemini Provider — 使用 @google/genai SDK 调用 Google Gemini 模型

import { GoogleGenAI } from "@google/genai";
import type { AIProvider, GenerateAltRequest, GenerateAltResult, ModelCallRecord } from "../ai.types.js";
import { AIGenerationError } from "../ai.types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger({ module: "gemini-provider" });

export interface GeminiProviderConfig {
  apiKey: string;
  model: string;
  endpoint?: string;
  timeoutMs: number;
  label: string;
}

function classifyNetworkError(err: unknown): "SERVER" | "NON_SERVER" {
  if (err instanceof TypeError) return "NON_SERVER";
  if (err instanceof Error && err.name === "AbortError") return "NON_SERVER";
  return "NON_SERVER";
}

export class GeminiProvider implements AIProvider {
  private readonly config: Required<GeminiProviderConfig>;
  private readonly client: GoogleGenAI;

  constructor(config: GeminiProviderConfig) {
    this.config = {
      ...config,
      endpoint: config.endpoint ?? "https://generativelanguage.googleapis.com",
    };
    this.client = new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: {
        baseUrl: this.config.endpoint,
        timeout: config.timeoutMs,
      },
    });
  }

  get modelName(): string {
    return `google/${this.config.model}`;
  }

  private get tierLabel(): string {
    return this.config.label === "primary" ? "PRIMARY" : this.config.label;
  }

  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const { model, timeoutMs } = this.config;
    const modelName = this.modelName;
    const start = Date.now();
    let raceSettled = false;

    // 1. 下载图片 → base64
    let base64Data: string;
    let mimeType = "image/jpeg";

    try {
      const response = await fetch(req.imageUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type");
      if (contentType) mimeType = contentType;
      const arrayBuffer = await response.arrayBuffer();
      base64Data = Buffer.from(arrayBuffer).toString("base64");
    } catch (err) {
      const durationMs = Date.now() - start;
      log.warn(
        { event: "provider.call.failed", modelName, durationMs, reason: "image_fetch_error", err: String(err) },
        `[${this.tierLabel}] Gemini 图片下载失败`,
      );
      const record: ModelCallRecord = {
        modelName,
        durationMs,
        status: "FAILED",
        failureOrigin: "NON_SERVER",
        errorMessage: `图片下载失败: ${err instanceof Error ? err.message : String(err)}`,
      };
      throw new AIGenerationError(`[Gemini] 图片下载失败: ${err instanceof Error ? err.message : String(err)}`, err, [record]);
    }

    // 2. 构建 prompt
    const prompt = req.locale === "zh-CN"
      ? "根据图片及上下文信息，输出简洁、描述性的 Alt Text（纯文本，无引号）。"
      : "Based on the image and context, output a concise, descriptive Alt Text (plain text, no quotes).";

    // 3. 调用 Gemini API（含超时保护）
    try {
      const result = await Promise.race<ReturnType<typeof this.client.models.generateContent>>([
        this.client.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                mimeType,
                data: base64Data,
              },
            },
            { text: prompt },
          ],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            raceSettled = true;
            reject(new AIGenerationError(`[Gemini] 请求超时（${timeoutMs}ms）`));
          }, timeoutMs),
        ),
      ]);

      if (raceSettled) return undefined as unknown as GenerateAltResult;

      const durationMs = Date.now() - start;
      const altText = result.text?.trim();

      if (!altText) {
        log.warn(
          { event: "provider.call.failed", modelName, durationMs, reason: "empty_content" },
          `[${this.tierLabel}] Gemini 响应内容为空`,
        );
        const record: ModelCallRecord = {
          modelName,
          durationMs,
          status: "FAILED",
          failureOrigin: "SERVER",
          errorMessage: "响应内容为空",
        };
        throw new AIGenerationError("[Gemini] 响应内容为空", undefined, [record]);
      }

      log.info(
        { event: "provider.call.success", modelName, durationMs },
        `[${this.tierLabel}] Gemini 调用成功`,
      );

      return {
        altText,
        modelUsed: modelName,
        modelCalls: [{ modelName, durationMs, status: "SUCCESS" }],
      } satisfies GenerateAltResult;
    } catch (err) {
      if (raceSettled) return undefined as unknown as GenerateAltResult;
      if (err instanceof AIGenerationError && err.modelCalls && err.modelCalls.length > 0) throw err;

      const durationMs = Date.now() - start;
      const failureOrigin = classifyNetworkError(err);
      const record: ModelCallRecord = {
        modelName,
        durationMs,
        status: "FAILED",
        failureOrigin,
        errorMessage: err instanceof Error ? err.message : String(err),
      };

      log.warn(
        { event: "provider.call.failed", modelName, durationMs, err: String(err) },
        `[${this.tierLabel}] Gemini 调用失败`,
      );

      throw new AIGenerationError(
        `[Gemini] ${err instanceof Error ? err.message : String(err)}`,
        err,
        [record],
      );
    }
  }
}
