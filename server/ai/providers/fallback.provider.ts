// server/ai/providers/fallback.provider.ts
// FallbackProvider — 串联两个 Provider，主失败后自动切换副模型

import type { AIProvider, GenerateAltRequest, GenerateAltResult, ModelCallRecord } from "../ai.types.js";
import { AIGenerationError } from "../ai.types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger({ module: "ai-gateway", provider: "fallback" });

export class FallbackProvider implements AIProvider {
  constructor(
    private readonly primary: AIProvider,
    private readonly secondary: AIProvider,
    private readonly primaryName: string,
    private readonly secondaryName: string,
  ) {}

  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const allCalls: ModelCallRecord[] = [];

    try {
      const result = await this.primary.generateAlt(req);
      allCalls.push(...result.modelCalls);
      log.info(
        {
          event: "ai.primary.success",
          provider: this.primaryName,
          modelUsed: result.modelUsed,
          callCount: result.modelCalls.length,
        },
        "主模型调用成功",
      );
      return { ...result, modelCalls: allCalls };
    } catch (primaryErr) {
      if (primaryErr instanceof AIGenerationError && primaryErr.modelCalls) {
        allCalls.push(...primaryErr.modelCalls);
      }
      log.warn(
        {
          event: "ai.primary.failed",
          provider: this.primaryName,
          callCount: allCalls.length,
          err: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        },
        "主模型失败，切换副模型",
      );
    }

    try {
      const result = await this.secondary.generateAlt(req);
      allCalls.push(...result.modelCalls);
      log.info(
        {
          event: "ai.fallback.success",
          provider: this.secondaryName,
          modelUsed: result.modelUsed,
          callCount: result.modelCalls.length,
        },
        "副模型调用成功",
      );
      return { ...result, modelCalls: allCalls };
    } catch (secondaryErr) {
      if (secondaryErr instanceof AIGenerationError && secondaryErr.modelCalls) {
        allCalls.push(...secondaryErr.modelCalls);
      }
      log.error(
        {
          event: "ai.fallback.failed",
          provider: this.secondaryName,
          callCount: allCalls.length,
          err: secondaryErr instanceof Error ? secondaryErr.message : String(secondaryErr),
        },
        "主模型与副模型均失败",
      );
      throw new AIGenerationError(
        "主模型与副模型均调用失败，无法生成 Alt Text",
        secondaryErr,
        allCalls,
      );
    }
  }
}
