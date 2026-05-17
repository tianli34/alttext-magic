// server/ai/ai.types.ts
// AI Gateway 统一类型定义 — 对上层屏蔽具体模型差异

import { AltDraftContextMode } from "@prisma/client";

// 上下文快照：生成 Alt Text 时所需的资源元数据
export type ContextSnapshot = Record<string, unknown>;

// ----------------------------------------------------------------
// 请求 / 响应
// ----------------------------------------------------------------

export interface GenerateAltRequest {
  imageUrl: string;
  contextSnapshot: ContextSnapshot;
  contextMode: AltDraftContextMode;
  locale?: "en" | "zh-CN";
}

export interface GenerateAltResult {
  altText: string;
  modelUsed: string;
}

// ----------------------------------------------------------------
// 错误类型
// ----------------------------------------------------------------

export class AIGenerationError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AIGenerationError";
  }
}

// ----------------------------------------------------------------
// Provider 接口
// ----------------------------------------------------------------

export interface AIProvider {
  generateAlt(req: GenerateAltRequest): Promise<GenerateAltResult>;
}
