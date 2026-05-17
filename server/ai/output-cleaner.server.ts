// server/ai/output-cleaner.server.ts
// AI 输出文本清洗器 — 标准化 Alt Text 格式

/**
 * 清洗 AI 返回的原始 Alt Text
 * 
 * 英文规则：
 * 1. 去除首尾空白 (trim)
 * 2. 去除开头的引号包裹 (Remove surrounding quotes)
 * 3. 去除 "image of" / "photo of" / "picture of" 等开头 (不区分大小写)
 * 4. 截断至 ≤ 125 字符 (在最后一个完整单词处截断，加 "..." 如超出)
 * 5. 如果结果为空，抛出错误
 * 
 * 中文规则：
 * 1. 去除首尾空白
 * 2. 去除开头的引号包裹
 * 3. 跳过英文特有的前缀去除和首字母大写
 * 4. 截断至 ≤ 75 字符
 * 
 * @param rawText AI 返回的原始文本
 * @param locale 语言区域 ("en" | "zh-CN")
 * @returns 经过清洗和标准化的 Alt Text
 */
export function cleanAltText(rawText: string, locale: "en" | "zh-CN" = "en"): string {
  if (!rawText) {
    throw new Error("AI returned empty content");
  }

  let text = rawText.trim();

  // 去除开头的引号包裹 (通用)
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.substring(1, text.length - 1).trim();
  } else if (text.startsWith("'") && text.endsWith("'")) {
    text = text.substring(1, text.length - 1).trim();
  }

  if (locale === "zh-CN") {
    if (!text) {
      throw new Error("Alt text became empty after cleaning");
    }

    // 截断至 ≤ 75 字符（中文按字符截断，无需单词边界）
    const MAX_LENGTH = 75;
    if (text.length > MAX_LENGTH) {
      text = text.substring(0, MAX_LENGTH - 3).trimEnd() + "...";
    }

    return text;
  }

  // ── 英文规则 ──

  // 去除 "image of" / "photo of" / "picture of" 等开头
  const prefixRegex = /^(?:(?:an?|the)\s+)?(?:image|photo|picture|graphic|illustration)\s+of(?:\s+|$)/i;
  text = text.replace(prefixRegex, "");

  text = text.trim();

  if (!text) {
    throw new Error("Alt text became empty after cleaning");
  }

  // 处理全大写情况
  if (text === text.toUpperCase() && text !== text.toLowerCase() && text.length > 5) {
    text = text.toLowerCase();
  }

  // 首字母大写
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // 截断至 ≤ 125 字符
  const MAX_LENGTH = 125;
  if (text.length > MAX_LENGTH) {
    let truncated = text.substring(0, MAX_LENGTH - 3);

    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > MAX_LENGTH * 0.7) {
      truncated = truncated.substring(0, lastSpace);
    }

    text = truncated.trim() + "...";
  }

  return text;
}
