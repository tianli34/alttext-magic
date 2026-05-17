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
  contextMode: AltDraftContextMode,
  locale: "en" | "zh-CN" = "en",
): { systemPrompt: string; userPrompt: string } {

  // 1. System Prompt: 角色设定与硬性约束
  const systemPrompt = locale === "zh-CN"
    ? [
        "你是一个专业的 Shopify 电商图片 Alt Text 生成助手。",
        "请根据提供的图片及上下文信息，生成准确、简洁、对搜索引擎友好的 Alt Text。",
        "规则：",
        "- 用中文撰写 Alt Text",
        "- 简洁、具体、描述性",
        "- 不超过 75 个汉字",
        "- 不要以'图片'、'照片'、'图像'开头",
        "- 不要关键词堆砌或使用'产品图片'等泛泛描述",
      ].join("\n")
    : [
        "You are an accessibility expert writing alt text for e-commerce images.",
        "Your output MUST follow these rules:",
        "- Write in English.",
        "- Be concise, specific, and descriptive.",
        "- Keep it under 125 characters.",
        "- Do NOT start with 'image of', 'photo of', or 'picture of'.",
        "- Do NOT use keyword stuffing or generic descriptions like 'product image'.",
      ].join("\n");

  // 2. User Prompt: 核心输入与上下文注入
  let userPrompt = locale === "zh-CN"
    ? `待描述图片：${imageUrl}\n\n`
    : `Image to describe: ${imageUrl}\n\n`;

  switch (contextMode) {
    case AltDraftContextMode.RESOURCE_SPECIFIC:
      const resourceName =
        (contextSnapshot.productTitle as string) ||
        (contextSnapshot.collectionTitle as string) ||
        (contextSnapshot.articleTitle as string) ||
        (contextSnapshot.title as string);

      if (resourceName) {
        userPrompt += locale === "zh-CN"
          ? `上下文：该图片属于资源"${resourceName}"。\n说明：在描述中包含资源名称以帮助视障用户理解。`
          : `Context: This image is part of a product or collection titled "${resourceName}".\nInstruction: Incorporate the product/collection name if it helps provide a better description for visually impaired users.`;
      } else {
        userPrompt += locale === "zh-CN"
          ? `上下文：无可用资源元数据。\n说明：准确描述图片内容。`
          : `Context: No specific resource metadata available.\nInstruction: Describe the image content accurately.`;
      }
      break;

    case AltDraftContextMode.FILE_NEUTRAL:
      userPrompt += locale === "zh-CN"
        ? `上下文：通用文件图片。\n说明：仅描述图片中视觉可见的内容。除非品牌名或产品名在图片中清晰可见，否则不要猜测。`
        : `Context: General file image.\nInstruction: Describe ONLY what is visually apparent in the image. Do not guess the brand or product name unless it's clearly visible in the image.`;
      break;

    case AltDraftContextMode.SHARED_NEUTRAL:
      userPrompt += locale === "zh-CN"
        ? `上下文：共享资源图片。\n说明：对图片内容进行通用描述。重要：不要在回复中提及任何特定产品名称、品牌名或唯一资源标识。`
        : `Context: Shared resource image.\nInstruction: Describe the image content generally. IMPORTANT: Do NOT mention any specific product name, brand name, or unique resource identifiers in your response.`;
      break;

    default:
      userPrompt += locale === "zh-CN"
        ? `说明：为无障碍目的准确描述图片内容。`
        : `Instruction: Describe the image content accurately for accessibility purposes.`;
  }

  return { systemPrompt, userPrompt };
}
