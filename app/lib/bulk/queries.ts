// src/lib/bulk/queries.ts
// Shopify Bulk Operation GraphQL 查询定义
// 每个常量对应一类 bulkOperationRunQuery 的 query 参数

/**
 * 产品媒体查询
 * NDJSON 输出：
 *   父行 → Product { id, title }
 *   子行 → MediaImage { id, image{url,altText}, position, __parentId }
 */
export const BULK_QUERY_PRODUCT_MEDIA = /* graphql */ `
  {
    products {
      edges {
        node {
          id
          title
          media {
            edges {
              node {
                ... on MediaImage {
                  id
                  image {
                    url
                    altText
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * 店铺文件库图片查询
 * NDJSON 输出：
 *   每行 → MediaImage { id, image{url,altText} }
 *   （无子行，无 __parentId）
 */
export const BULK_QUERY_FILES = /* graphql */ `
  {
    files(query: "media_type:Image") {
      edges {
        node {
          ... on MediaImage {
            id
            image {
              url
              altText
            }
          }
        }
      }
    }
  }
`;

/**
 * 集合查询
 * NDJSON 输出：
 *   每行 → Collection { id, title, image{url,altText} }
 */
export const BULK_QUERY_COLLECTIONS = /* graphql */ `
  {
    collections {
      edges {
        node {
          id
          title
          image {
            url
            altText
          }
        }
      }
    }
  }
`;

/**
 * 文章查询
 * NDJSON 输出：
 *   每行 → Article { id, title, image{url,altText} }
 */
export const BULK_QUERY_ARTICLES = /* graphql */ `
  {
    articles {
      edges {
        node {
          id
          title
          image {
            url
            altText
          }
        }
      }
    }
  }
`;