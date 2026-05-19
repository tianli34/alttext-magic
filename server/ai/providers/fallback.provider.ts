// server/ai/providers/fallback.provider.ts
// FallbackProvider — 串联多个 Provider，按序逐一尝试，全部失败则抛异常

import type { AIProvider, GenerateAltRequest, GenerateAltResult, ModelCallRecord } from "../ai.types.js";
import { AIGenerationError } from "../ai.types.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger({ module: "ai-gateway", provider: "fallback" });

export interface ProviderEntry {
  provider: AIProvider;
  name: string;
}

export class FallbackProvider implements AIProvider {
  constructor(
    private readonly entries: ProviderEntry[],
  ) {}

  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const allCalls: ModelCallRecord[] = [];
    let lastError: unknown;

    for (const { provider, name } of this.entries) {
      try {
        const result = await provider.generateAlt(req);
        allCalls.push(...result.modelCalls);
        log.info(
          {
            event: "ai.provider.success",
            provider: name,
            modelUsed: result.modelUsed,
            callCount: result.modelCalls.length,
          },
          `模型 ${name} 调用成功`,
        );
        return { ...result, modelCalls: allCalls };
      } catch (err) {
        if (err instanceof AIGenerationError && err.modelCalls) {
          allCalls.push(...err.modelCalls);
        }
        log.warn(
          {
            event: "ai.provider.failed",
            provider: name,
            callCount: allCalls.length,
            err: err instanceof Error ? err.message : String(err),
          },
          `模型 ${name} 失败，切换下一模型`,
        );
        lastError = err;
      }
    }

    log.error(
      {
        event: "ai.all.failed",
        providerCount: this.entries.length,
        callCount: allCalls.length,
      },
      "所有模型均调用失败",
    );

    throw new AIGenerationError(
      `所有 ${this.entries.length} 个模型均调用失败，无法生成 Alt Text`,
      lastError,
      allCalls,
    );
  }
}
