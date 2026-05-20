// server/ai/ai-gateway.ts
// AIGatewayService — 统一抽象层，对上层屏蔽具体 Provider 差异
// 根据 AI_PROVIDER 环境变量决定使用 Fake / 真实 Provider

import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import type { AIProvider, GenerateAltRequest, GenerateAltResult } from "./ai.types.js";
import { AIGenerationError } from "./ai.types.js";
import { FakeAIProvider } from "./providers/fake.provider.js";
import { FallbackProvider } from "./providers/fallback.provider.js";
import type { ProviderEntry } from "./providers/fallback.provider.js";
import { GeminiProvider } from "./providers/gemini.provider.js";
import { OpenAICompatibleProvider } from "./providers/openai.provider.js";

const log = createLogger({ module: "ai-gateway" });

// 调用超时（毫秒）
const TIMEOUT_MS = 30_000 * 3;

// -------------------------------------------------------------------
// 模型配置映射表 —— 加新候补只需在此追加一条
// env 字段通过 (env as any) 动态读取，系故意为之：
//   避免为 DRY 辅助函数编写与 Env 类型耦合的类型体操，违反「禁止 any」
//   但此处 as any 限于严格封装范围内，不扩散至项目其他部分
// -------------------------------------------------------------------
interface ModelConfigMeta {
  providerKey: string;
  modelKey: string;
  apiKeyKey: string;
  endpointKey: string;
  label: string;
}

const MODEL_CONFIGS: ModelConfigMeta[] = [
  { providerKey: "AI_PRIMARY_PROVIDER", modelKey: "AI_PRIMARY_MODEL", apiKeyKey: "AI_PRIMARY_API_KEY", endpointKey: "AI_PRIMARY_ENDPOINT", label: "primary" },
  { providerKey: "AI_2nd_PROVIDER",     modelKey: "AI_2nd_MODEL",     apiKeyKey: "AI_2nd_API_KEY",     endpointKey: "AI_2nd_ENDPOINT",     label: "2nd" },
  { providerKey: "AI_3rd_PROVIDER",     modelKey: "AI_3rd_MODEL",     apiKeyKey: "AI_3rd_API_KEY",     endpointKey: "AI_3rd_ENDPOINT",     label: "3rd" },
  { providerKey: "AI_4th_PROVIDER",     modelKey: "AI_4th_MODEL",     apiKeyKey: "AI_4th_API_KEY",     endpointKey: "AI_4th_ENDPOINT",     label: "4th" },
  { providerKey: "AI_5th_PROVIDER",     modelKey: "AI_5th_MODEL",     apiKeyKey: "AI_5th_API_KEY",     endpointKey: "AI_5th_ENDPOINT",     label: "5th" },
  { providerKey: "AI_6th_PROVIDER",     modelKey: "AI_6th_MODEL",     apiKeyKey: "AI_6th_API_KEY",     endpointKey: "AI_6th_ENDPOINT",     label: "6th" },
  { providerKey: "AI_7th_PROVIDER",     modelKey: "AI_7th_MODEL",     apiKeyKey: "AI_7th_API_KEY",     endpointKey: "AI_7th_ENDPOINT",     label: "7th" },
  { providerKey: "AI_8th_PROVIDER",     modelKey: "AI_8th_MODEL",     apiKeyKey: "AI_8th_API_KEY",     endpointKey: "AI_8th_ENDPOINT",     label: "8th" },
];

/** 根据 MODEL_CONFIGS 动态构建所有已配置（apiKey 非空）的 Provider 条目 */
function buildModelProviders(): ProviderEntry[] {
  // 使用 (env as any) 理由见 MODEL_CONFIGS 上方注释
  const e = env as any;
  return MODEL_CONFIGS
    .filter((cfg) => e[cfg.apiKeyKey])
    .map((cfg) => {
      const providerName = e[cfg.providerKey] as string;
      const model = e[cfg.modelKey] as string;
      const apiKey = e[cfg.apiKeyKey] as string;
      const endpoint = e[cfg.endpointKey] as string | undefined;

      if (providerName === "google") {
        return {
          provider: new GeminiProvider({ apiKey, model, endpoint, timeoutMs: TIMEOUT_MS, label: cfg.label }),
          name: `google/${model}`,
        };
      }

      return {
        provider: new OpenAICompatibleProvider({
          providerName,
          model,
          apiKey,
          endpoint,
          timeoutMs: TIMEOUT_MS,
          label: cfg.label,
        }),
        name: `${providerName}/${model}`,
      };
    });
}

// ----------------------------------------------------------------
// Provider 工厂
// ----------------------------------------------------------------
function buildProvider(): AIProvider {
  // Fake 模式：本地开发 / 测试
  if (env.AI_PROVIDER === "fake") {
    log.info({ event: "ai.gateway.init", mode: "fake" }, "使用 FakeAIProvider");
    return new FakeAIProvider();
  }

  // 真实模式：动态收集所有已配置的模型，构建多级降级链
  const providers = buildModelProviders();

  log.info(
    {
      event: "ai.gateway.init",
      mode: "real",
      providerCount: providers.length,
      models: providers.map((p) => p.name),
    },
    `使用 ${providers.length} 个模型的多级降级 Provider`,
  );

  return new FallbackProvider(providers);
}

// ----------------------------------------------------------------
// AIGatewayService — 单例门面
// ----------------------------------------------------------------
class AIGatewayService {
  // 懒初始化，首次调用时构建 provider
  private provider: AIProvider | null = null;

  private getProvider(): AIProvider {
    if (!this.provider) {
      this.provider = buildProvider();
    }
    return this.provider;
  }

  /**
   * 生成 Alt Text
   * - AI_PROVIDER=fake → 立即返回确定性假文本
   * - 否则 → 主模型失败自动切换副模型；主副均失败 → 抛出 AIGenerationError
   */
  async generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult> {
    const start = Date.now();
    log.info(
      { event: "ai.gateway.generate.start", imageUrl: req.imageUrl, contextMode: req.contextMode },
      "开始生成 Alt Text",
    );

    try {
      const result = await this.getProvider().generateAlt(req);
      log.info(
        {
          event: "ai.gateway.generate.success",
          modelUsed: result.modelUsed,
          durationMs: Date.now() - start,
        },
        "Alt Text 生成成功",
      );
      return result;
    } catch (err) {
      log.error(
        {
          event: "ai.gateway.generate.failed",
          durationMs: Date.now() - start,
          err: err instanceof Error ? err.message : String(err),
        },
        "Alt Text 生成失败",
      );
      if (err instanceof AIGenerationError) throw err;
      throw new AIGenerationError("AI 生成意外失败", err);
    }
  }

  /** 用于测试注入自定义 Provider（仅在测试环境调用） */
  _setProvider(provider: AIProvider): void {
    this.provider = provider;
  }
}

// 导出单例
export const aiGatewayService = new AIGatewayService();
// 同时导出类本身，方便测试中 new 出独立实例
export { AIGatewayService };
