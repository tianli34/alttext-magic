// server/ai/ai.types.ts
// AI Gateway 统一类型定义 — 对上层屏蔽具体模型差异
// ----------------------------------------------------------------
// 错误类型
// ----------------------------------------------------------------
export class AIGenerationError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.cause = cause;
        this.name = "AIGenerationError";
    }
}
