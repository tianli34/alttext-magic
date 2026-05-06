已实现 SSE 鉴权升级：

- [app/hooks/useSSE.ts]：改用 `@microsoft/fetch-event-source`，通过 App Bridge `shopify.idToken()` 获取 Session Token，并用 `Authorization: Bearer <token>` 发起 SSE 请求。
- [app/routes/api.sse.tsx]：SSE 端点要求 Bearer Token；缺失、失效、或 Shopify 鉴权抛出 401/重定向时，统一直接返回 `401 Unauthorized`，不再允许 302 登录跳转。
- [docs/STATUS.md]：已按要求追加极简状态记录。

验证：`npm run typecheck` 通过。
