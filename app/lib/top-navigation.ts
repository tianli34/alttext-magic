/**
 * File: app/lib/top-navigation.ts
 * Purpose: 嵌入式 App 顶层导航工具。
 *          应用以 iframe 嵌入 Shopify Admin 时，直接访问 window.top.location
 *          会因跨域被浏览器拒绝（Firefox: Permission denied to access
 *          property "assign" on cross-origin object），故统一经此函数跳转。
 */

/** 仅允许 http(s) 顶层导航，防止开放重定向到危险协议 */
function assertHttpUrl(url: string): void {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('非法的跳转地址');
  }
}

/** 弹窗被拦截时的降级方案：以顶层锚点点击触发导航 */
function fallbackAnchorClick(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_top';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * 在顶层窗口打开计费确认页等外部地址。
 * 使用 window.open(url, "_top") 而非 window.top.location.assign，
 * 前者仅请求导航、无需读取跨域 Location 对象，可通过浏览器同源策略检查。
 *
 * @param url 完整的 https 跳转地址（Shopify confirmationUrl）
 */
export function openTopLevel(url: string): void {
  assertHttpUrl(url);

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('顶层导航仅可在浏览器环境执行');
  }

  try {
    const opened = window.open(url, '_top');
    // 弹窗拦截器拦截时返回 null，降级为锚点点击
    if (opened === null) {
      fallbackAnchorClick(url);
    }
  } catch {
    fallbackAnchorClick(url);
  }
}
