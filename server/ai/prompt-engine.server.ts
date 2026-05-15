// server/ai/prompt-engine.server.ts
// Prompt 模板引擎 — 根据 context_mode 构建 AI 提示词

import { AltDraftContextMode } from "@prisma/client";
import { ContextSnapshot } from "./ai.types";

/**
 * 构建 AI 生成 Alt Text 所需的 Prompt
 * 
 * @param imageUrl 图片 URL
 * @param contextSnapshot 资源上下文快照 (包含产品标题等)
 * @param contextMode 上下文模式 (RESOURCE_SPECIFIC / FILE_NEUTRAL / SHARED_NEUTRAL)
 * @returns { systemPrompt, userPrompt }
 */
export function buildPrompt(
  imageUrl: string,
  contextSnapshot: ContextSnapshot,
  contextMode: AltDraftContextMode
): { systemPrompt: string; userPrompt: string } {
  
  // 1. System Prompt: 角色设定与硬性约束
  const systemPrompt = [
    "You are an accessibility expert writing alt text for e-commerce images.",
    "Your output MUST follow these rules:",
    "- Write in English.",
    "- Be concise, specific, and descriptive.",
    "- Keep it under 125 characters.",
    "- Do NOT start with 'image of', 'photo of', or 'picture of'.",
    "- Do NOT use keyword stuffing or generic descriptions like 'product image'.",
  ].join("\n");

  // 2. User Prompt: 核心输入与上下文注入
  let userPrompt = `Image to describe: ${imageUrl}\n\n`;

  switch (contextMode) {
    case AltDraftContextMode.RESOURCE_SPECIFIC:
      // 注入具体资源名称 (产品/集合/文章)
      const resourceName = 
        (contextSnapshot.productTitle as string) || 
        (contextSnapshot.collectionTitle as string) || 
        (contextSnapshot.articleTitle as string) || 
        (contextSnapshot.title as string);
      
      if (resourceName) {
        userPrompt += `Context: This image is part of a product or collection titled "${resourceName}".\n`;
        userPrompt += `Instruction: Incorporate the product/collection name if it helps provide a better description for visually impaired users.`;
      } else {
        userPrompt += `Context: No specific resource metadata available.\n`;
        userPrompt += `Instruction: Describe the image content accurately.`;
      }
      break;

    case AltDraftContextMode.FILE_NEUTRAL:
      // 无资源上下文，仅描述图片内容
      userPrompt += `Context: General file image.\n`;
      userPrompt += `Instruction: Describe ONLY what is visually apparent in the image. Do not guess the brand or product name unless it's clearly visible in the image.`;
      break;

    case AltDraftContextMode.SHARED_NEUTRAL:
      // 显式约束 "Do NOT mention any specific product name"
      userPrompt += `Context: Shared resource image.\n`;
      userPrompt += `Instruction: Describe the image content generally. IMPORTANT: Do NOT mention any specific product name, brand name, or unique resource identifiers in your response.`;
      break;

    default:
      userPrompt += `Instruction: Describe the image content accurately for accessibility purposes.`;
  }

  return { systemPrompt, userPrompt };
}
