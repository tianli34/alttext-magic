// server/ai/providers/fallback.provider.ts
// FallbackProvider — 串联两个 Provider，主失败后自动切换副模型
import { AIGenerationError } from "../ai.types.js";
import { createLogger } from "../../utils/logger.js";
const log = createLogger({ module: "ai-gateway", provider: "fallback" });
export class FallbackProvider {
    primary;
    secondary;
    primaryName;
    secondaryName;
    constructor(primary, secondary, primaryName, secondaryName) {
        this.primary = primary;
        this.secondary = secondary;
        this.primaryName = primaryName;
        this.secondaryName = secondaryName;
    }
    async generateAlt(req) {
        // ── 尝试主模型 ──────────────────────────────────────────────
        const primaryStart = Date.now();
        try {
            const result = await this.primary.generateAlt(req);
            log.info({
                event: "ai.primary.success",
                provider: this.primaryName,
                modelUsed: result.modelUsed,
                durationMs: Date.now() - primaryStart,
            }, "主模型调用成功");
            return result;
        }
        catch (primaryErr) {
            log.warn({
                event: "ai.primary.failed",
                provider: this.primaryName,
                durationMs: Date.now() - primaryStart,
                err: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
            }, "主模型失败，切换副模型");
        }
        // ── 尝试副模型 ──────────────────────────────────────────────
        const secondaryStart = Date.now();
        try {
            const result = await this.secondary.generateAlt(req);
            log.info({
                event: "ai.fallback.success",
                provider: this.secondaryName,
                modelUsed: result.modelUsed,
                durationMs: Date.now() - secondaryStart,
            }, "副模型调用成功");
            return result;
        }
        catch (secondaryErr) {
            const durationMs = Date.now() - secondaryStart;
            log.error({
                event: "ai.fallback.failed",
                provider: this.secondaryName,
                durationMs,
                err: secondaryErr instanceof Error ? secondaryErr.message : String(secondaryErr),
            }, "主模型与副模型均失败");
            throw new AIGenerationError("主模型与副模型均调用失败，无法生成 Alt Text", secondaryErr);
        }
    }
}
