Shopify 底层资产库已统一，`Product media` 是底层 `File/Media` 的引用；新版本已废弃 `productUpdateMedia`。对 **产品媒体与文件库图片** 的 Alt 更新，**优先使用 `fileUpdate` 更新全局资产**，并可同步到产品前端引用处。

> 注意：`fileUpdate` 要求目标文件处于 READY 状态（如可读到状态字段，建议写回前校验；否则按错误码重试/失败）。

## 开发防错指南：ID 格式

**核心陷阱：ID 格式错误会导致 404，绝不要使用旧版 ProductImage ID。**

### 1）查询规范（读）
不要查旧版产品 `images`。必须查产品 `media`，获取 **`MediaImage`** 的 ID。

- ✅ 正确：`gid://shopify/MediaImage/12345`
- ❌ 错误：`gid://shopify/ProductImage/12345`

### 2）写入规范（写）
使用 API Version: `2026-04`。将 **`MediaImage` ID** 作为 `fileUpdate` 的 `id` 传入：

```graphql
mutation {
  fileUpdate(files: [{
    id: "gid://shopify/MediaImage/12345",
    alt: "AI generated alt text"
  }]) {
    files { alt }
    userErrors { message }
  }
}
```

**执行结论**：只要 ID 是 `MediaImage`，调用一次 `fileUpdate` 即可完成全局生效，无需再做产品级额外更新。
