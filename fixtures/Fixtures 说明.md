# Fixtures 说明

本目录存放 Shopify Bulk Operation 查询的**脱敏离线样本**，用于单元测试与集成测试的离线回放。
所有真实店铺 ID、URL、商品名已替换为虚构占位数据。

---

## 文件列表

| 文件 | 对应查询常量 | 父实体类型 | 子实体类型 |
|------|-------------|-----------|-----------|
| `bulk_product_media.ndjson` | `BULK_QUERY_PRODUCT_MEDIA` | `Product` | `MediaImage`（含 `__parentId`） |
| `bulk_files.ndjson` | `BULK_QUERY_FILES` | — | `MediaImage`（顶层，无 `__parentId`） |
| `bulk_collections.ndjson` | `BULK_QUERY_COLLECTIONS` | — | `Collection`（顶层） |
| `bulk_articles.ndjson` | `BULK_QUERY_ARTICLES` | — | `Article`（顶层） |

---

## 行结构详解

### `bulk_product_media.ndjson`

Shopify Bulk Operation 对嵌套连接（Connection）的处理规则：
**父资源**输出一行，其**子资源**各输出一行，子行通过 `__parentId` 字段反向关联父行。

```
父行（Product）:
{
  "id": "gid://shopify/Product/<id>",
  "title": "<string>"
}

子行（MediaImage）:
{
  "id": "gid://shopify/MediaImage/<id>",
  "image": { "url": "<string>", "altText": "<string|null>" },
  "position": <number>,
  "__parentId": "gid://shopify/Product/<id>"   ← 指向父 Product 的 id
}
```

**重要**：`__parentId` 由 Shopify 自动注入，不在 GraphQL query 中声明。
解析时必须通过 `__parentId` 将子行与父行关联，不能依赖行的物理顺序。

示例（3 个产品，共 7 个 MediaImage 子行）：
- `Product/100001` → `MediaImage/1001`（position 1）、`MediaImage/1002`（position 2）
- `Product/100002` → `MediaImage/1003`、`1004`、`1005`
- `Product/100003` → `MediaImage/1006`、`1007`

---

### `bulk_files.ndjson`

文件库扁平列表，每行是一个顶层 `MediaImage`，**无** `__parentId`。

```
{
  "id": "gid://shopify/MediaImage/<id>",
  "image": { "url": "<string>", "altText": "<string|null>" }
}
```

**去重测试设计**：
`MediaImage/1001`、`1003`、`1006` 同时出现在 `bulk_product_media.ndjson` 中，
用于验证管线的去重逻辑（相同 `id` 不应重复写入数据库）。

---

### `bulk_collections.ndjson`

集合扁平列表，每行是一个 `Collection`，**无** `__parentId`。
`image` 字段可能为 `null`（集合未设置封面图时）。

```
{
  "id": "gid://shopify/Collection/<id>",
  "title": "<string>",
  "image": { "url": "<string>", "altText": "<string|null>" } | null
}
```

---

### `bulk_articles.ndjson`

文章扁平列表，每行是一个 `Article`，**无** `__parentId`。
`image` 字段可能为 `null`（文章未设置特色图时）。

```
{
  "id": "gid://shopify/Article/<id>",
  "title": "<string>",
  "image": { "url": "<string>", "altText": "<string|null>" } | null
}
```

---

## 注意事项

1. **ID 格式**：保持 `gid://shopify/<Type>/<numeric_id>` 格式，解析器依赖此格式提取类型与数字 ID。
2. **null 值**：`image` 为 null 的行必须保留，用于测试空值处理分支。
```
