// server/ai/providers/fake.provider.ts
// FakeAIProvider — 本地/测试用确定性 Provider，支持模拟延迟和模拟失败

import type { AIProvider, GenerateAltRequest, GenerateAltResult, ModelCallRecord } from "../ai.types.js";
import { AIGenerationError } from "../ai.types.js";

export class FakeAIProvider implements AIProvider {
  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const start = Date.now();
    const modelName = "fake-model";
    const { imageUrl } = req;

    if (imageUrl.includes("trigger-fake-failure")) {
      const durationMs = Date.now() - start;
      const record: ModelCallRecord = {
        modelName,
        durationMs,
        status: "FAILED",
        failureOrigin: "SERVER",
        errorMessage: "Simulated fake provider failure",
      };
      throw new AIGenerationError("Simulated fake provider failure", undefined, [record]);
    }

    if (imageUrl.includes("trigger-fake-delay")) {
      await new Promise<void>((resolve) => setTimeout(resolve, 32_000));
    }

    const filename = imageUrl.split("/").pop() ?? "unknown";
    const durationMs = Date.now() - start;

    return {
      altText: `Fake alt for ${filename}`,
      modelUsed: modelName,
      modelCalls: [
        { modelName, durationMs, status: "SUCCESS" },
      ],
    };
  }
}
