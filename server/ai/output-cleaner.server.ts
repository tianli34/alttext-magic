// server/ai/output-cleaner.server.ts
// AI 输出文本清洗器 — 标准化 Alt Text 格式

/**
 * 清洗 AI 返回的原始 Alt Text
 * 
 * 规则：
 * 1. 去除首尾空白 (trim)
 * 2. 去除开头的引号包裹 (Remove surrounding quotes)
 * 3. 去除 "image of" / "photo of" / "picture of" 等开头 (不区分大小写)
 * 4. 截断至 ≤ 125 字符 (在最后一个完整单词处截断，加 "..." 如超出)
 * 5. 如果结果为空，抛出错误
 * 
 * @param rawText AI 返回的原始文本
 * @returns 经过清洗和标准化的 Alt Text
 */
export function cleanAltText(rawText: string): string {
  if (!rawText) {
    throw new Error("AI returned empty content");
  }

  let text = rawText.trim();

  // 1. 去除开头的引号包裹 (例如 "some alt text" -> some alt text)
  // 有些 AI 会返回带有引号的字符串
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.substring(1, text.length - 1).trim();
  } else if (text.startsWith("'") && text.endsWith("'")) {
    text = text.substring(1, text.length - 1).trim();
  }

  // 2. 去除 "image of" / "photo of" / "picture of" / "a photo of" 等开头
  // 使用正则匹配，不区分大小写
  const prefixRegex = /^(?:(?:an?|the)\s+)?(?:image|photo|picture|graphic|illustration)\s+of(?:\s+|$)/i;
  text = text.replace(prefixRegex, "");

  // 再次 trim 以防前缀去除后留下空格
  text = text.trim();

  if (!text) {
    throw new Error("Alt text became empty after cleaning");
  }

  // 3. 处理全大写情况 (全大写对读屏器不友好，且不美观)
  if (text === text.toUpperCase() && text !== text.toLowerCase() && text.length > 5) {
    text = text.toLowerCase();
  }

  // 首字母大写
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // 4. 截断至 ≤ 125 字符
  const MAX_LENGTH = 125;
  if (text.length > MAX_LENGTH) {
    // 预留 3 个字符给 "..."
    let truncated = text.substring(0, MAX_LENGTH - 3);
    
    // 尝试在最后一个空格处截断
    const lastSpace = truncated.lastIndexOf(" ");
    if (lastSpace > MAX_LENGTH * 0.7) { // 只有当空格在较后位置时才在空格截断，否则硬截断
      truncated = truncated.substring(0, lastSpace);
    }
    
    text = truncated.trim() + "...";
  }

  return text;
}
