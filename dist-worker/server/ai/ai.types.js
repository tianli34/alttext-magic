// server/ai/ai.types.ts
// AI Gateway 统一类型定义 — 对上层屏蔽具体模型差异
// ----------------------------------------------------------------
// 错误类型
// ----------------------------------------------------------------
export class AIGenerationError extends Error {
    cause;
    modelCalls;
    constructor(message, cause, modelCalls) {
        super(message);
        this.cause = cause;
        this.modelCalls = modelCalls;
        this.name = "AIGenerationError";
    }
}
