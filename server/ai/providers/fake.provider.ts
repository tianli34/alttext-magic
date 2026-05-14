// server/ai/providers/fake.provider.ts
// FakeAIProvider — 本地/测试用确定性 Provider，支持模拟延迟和模拟失败

import type { AIProvider, GenerateAltRequest, GenerateAltResult } from "../ai.types.js";

/**
 * 特殊 imageUrl 关键字触发规则（用于单元测试）：
 *   - 包含 "trigger-fake-failure" → 抛出错误
 *   - 包含 "trigger-fake-delay"   → 等待 32 秒（足以触发 30s 超时）
 */
export class FakeAIProvider implements AIProvider {
  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const { imageUrl } = req;

    // 模拟失败
    if (imageUrl.includes("trigger-fake-failure")) {
      throw new Error("Simulated fake provider failure");
    }

    // 模拟超时（延迟超过网关 30s 上限）
    if (imageUrl.includes("trigger-fake-delay")) {
      await new Promise<void>((resolve) => setTimeout(resolve, 32_000));
    }

    // 确定性结果：取 URL 最后一段作为文件名
    const filename = imageUrl.split("/").pop() ?? "unknown";

    return {
      altText: `Fake alt for ${filename}`,
      modelUsed: "fake-model",
    };
  }
}
