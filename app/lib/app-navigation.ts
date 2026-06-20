/**
 * File: app/lib/app-navigation.ts
 * Purpose: 保留 Shopify 嵌入式 App 导航所需的 shop/host 查询参数。
 */

/** 构造受保护 /app 路由路径，合并当前 query 与目标 query。 */
export function buildAppPath(path: string, currentSearch: string): string {
  const [pathname, targetSearch = ""] = path.split("?");
  const params = new URLSearchParams(currentSearch);
  const targetParams = new URLSearchParams(targetSearch);

  targetParams.forEach((value, key) => {
    params.set(key, value);
  });

  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}
