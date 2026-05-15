// server/ai/ai-gateway.ts
// AIGatewayService — 统一抽象层，对上层屏蔽具体 Provider 差异
// 根据 AI_PROVIDER 环境变量决定使用 Fake / 真实 Provider
import { env } from "../config/env.js";
import { createLogger } from "../utils/logger.js";
import { AIGenerationError } from "./ai.types.js";
import { FakeAIProvider } from "./providers/fake.provider.js";
import { FallbackProvider } from "./providers/fallback.provider.js";
import { OpenAICompatibleProvider } from "./providers/openai.provider.js";
const log = createLogger({ module: "ai-gateway" });
// 调用超时（毫秒）
const TIMEOUT_MS = 30_000;
// ----------------------------------------------------------------
// Provider 工厂
// ----------------------------------------------------------------
function buildProvider() {
    // Fake 模式：本地开发 / 测试
    if (env.AI_PROVIDER === "fake") {
        log.info({ event: "ai.gateway.init", mode: "fake" }, "使用 FakeAIProvider");
        return new FakeAIProvider();
    }
    // 真实模式：主 + 副 fallback
    const primary = new OpenAICompatibleProvider({
        providerName: env.AI_PRIMARY_PROVIDER,
        model: env.AI_PRIMARY_MODEL,
        apiKey: env.AI_PRIMARY_API_KEY,
        endpoint: env.AI_PRIMARY_ENDPOINT,
        timeoutMs: TIMEOUT_MS,
    });
    const secondary = new OpenAICompatibleProvider({
        providerName: env.AI_FALLBACK_PROVIDER,
        model: env.AI_FALLBACK_MODEL,
        apiKey: env.AI_FALLBACK_API_KEY,
        endpoint: env.AI_FALLBACK_ENDPOINT,
        timeoutMs: TIMEOUT_MS,
    });
    log.info({
        event: "ai.gateway.init",
        mode: "real",
        primary: `${env.AI_PRIMARY_PROVIDER}/${env.AI_PRIMARY_MODEL}`,
        fallback: `${env.AI_FALLBACK_PROVIDER}/${env.AI_FALLBACK_MODEL}`,
    }, "使用主/副双模型 Provider");
    return new FallbackProvider(primary, secondary, env.AI_PRIMARY_PROVIDER, env.AI_FALLBACK_PROVIDER);
}
// ----------------------------------------------------------------
// AIGatewayService — 单例门面
// ----------------------------------------------------------------
class AIGatewayService {
    // 懒初始化，首次调用时构建 provider
    provider = null;
    getProvider() {
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
    async generateAlt(req) {
        const start = Date.now();
        log.info({ event: "ai.gateway.generate.start", imageUrl: req.imageUrl, contextMode: req.contextMode }, "开始生成 Alt Text");
        try {
            const result = await this.getProvider().generateAlt(req);
            log.info({
                event: "ai.gateway.generate.success",
                modelUsed: result.modelUsed,
                durationMs: Date.now() - start,
            }, "Alt Text 生成成功");
            return result;
        }
        catch (err) {
            log.error({
                event: "ai.gateway.generate.failed",
                durationMs: Date.now() - start,
                err: err instanceof Error ? err.message : String(err),
            }, "Alt Text 生成失败");
            if (err instanceof AIGenerationError)
                throw err;
            throw new AIGenerationError("AI 生成意外失败", err);
        }
    }
    /** 用于测试注入自定义 Provider（仅在测试环境调用） */
    _setProvider(provider) {
        this.provider = provider;
    }
}
// 导出单例
export const aiGatewayService = new AIGatewayService();
// 同时导出类本身，方便测试中 new 出独立实例
export { AIGatewayService };
