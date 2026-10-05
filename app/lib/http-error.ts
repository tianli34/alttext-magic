/**
 * File: app/lib/http-error.ts
 * Purpose: fetch 响应的安全解析与错误信息提取。
 *
 * 背景:前端错误分支若无条件 response.json(),一旦服务端/代理返回非 JSON 响应体
 * （鉴权会话失效的重定向页、React Router 未捕获异常的 HTML 错误页、Cloudflare
 * 隧道 502/520 错误页），浏览器的 JSON.parse 原生异常（如 Firefox 的
 * "JSON.parse: unexpected character at line 1 column 1 of the JSON data"）
 * 会替换真实错误显示给用户，且看不出是哪个接口出了问题。
 * 约定：错误分支用 extractResponseError（透出状态码与响应片段），
 *       成功分支用 parseJsonResponse（非 JSON 时抛可定位错误而非浏览器原生报错）。
 */

/** 非 JSON 响应片段的最大展示长度 */
const SNIPPET_MAX_LENGTH = 120;

/** 压缩空白后截取片段，供错误文案内嵌展示 */
function toSnippet(raw: string): string {
  const compressed = raw.replace(/\s+/g, " ").trim();
  return compressed.length > SNIPPET_MAX_LENGTH
    ? `${compressed.slice(0, SNIPPET_MAX_LENGTH)}…`
    : compressed;
}

/**
 * JSON.parse 的安全封装：失败返回 undefined，不抛异常。
 * 注意用 undefined（而非 null）作失败标记——JSON.parse("null") 是合法解析。
 */
function tryParseJson(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** 从解析后的 JSON 错误体中按优先级提取可读消息（error > message） */
function pickJsonErrorMessage(body: Record<string, unknown>): string | null {
  const { error, message } = body;
  if (typeof error === "string" && error) return error;
  if (typeof message === "string" && message) return message;
  return null;
}

/**
 * 从失败响应（非 2xx）提取可读错误消息：
 * - JSON 体：取 error/message 字段；都没有则退回「请求失败 (status)」
 * - 非 JSON（HTML 错误页/重定向页等）：透出状态码 + 响应片段，便于定位真实来源
 */
export async function extractResponseError(response: Response): Promise<string> {
  const status = response.status;

  let raw = "";
  try {
    raw = (await response.text()).trim();
  } catch {
    // 响应体已消费或流异常：至少保留状态码
    return `请求失败 (${status})`;
  }

  if (!raw) return `请求失败 (${status})`;

  const parsed = tryParseJson(raw);
  if (parsed !== undefined) {
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return pickJsonErrorMessage(parsed as Record<string, unknown>) ?? `请求失败 (${status})`;
    }
    // JSON 标量/数组错误体：无 error/message 字段可取
    return `请求失败 (${status})`;
  }

  return `请求失败 (${status})，响应非 JSON：${toSnippet(raw)}`;
}

/**
 * 解析响应的 JSON 体为指定类型（成功与失败分支通用）。
 * 服务端资源路由正常保证返回 JSON，但鉴权重定向被 fetch 跟随后可能拿到
 * HTML 页（有时还是 200），此处把解析失败转成带状态码与片段的可定位错误，
 * 不让浏览器原生 JSON.parse 异常漏到用户界面。
 */
export async function parseJsonResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();

  const parsed = tryParseJson(raw.trim());
  if (parsed === undefined) {
    const snippet = toSnippet(raw);
    throw new Error(
      snippet
        ? `响应非 JSON (${response.status})：${snippet}`
        : `响应体为空 (${response.status})`,
    );
  }
  return parsed as T;
}
