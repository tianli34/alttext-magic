import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  computeProductFingerprint,
  computeCollectionFingerprint,
} from "../server/modules/fingerprint/imageFingerprint";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

async function run(): Promise<void> {
  /* ================================================================ */
  /*  1. computeProductFingerprint — 空集合                           */
  /* ================================================================ */
  {
    const result = computeProductFingerprint([]);
    assert.equal(result, sha256(""), "空集合应返回空字符串的 sha256");
  }

  /* ================================================================ */
  /*  2. computeProductFingerprint — 顺序无关性                       */
  /* ================================================================ */
  {
    const images = [
      { id: "gid://shopify/MediaImage/3", alt: "alt3", imageUrl: "url3" },
      { id: "gid://shopify/MediaImage/1", alt: "alt1", imageUrl: "url1" },
      { id: "gid://shopify/MediaImage/2", alt: "alt2", imageUrl: "url2" },
    ];
    const shuffled = [
      { id: "gid://shopify/MediaImage/2", alt: "alt2", imageUrl: "url2" },
      { id: "gid://shopify/MediaImage/3", alt: "alt3", imageUrl: "url3" },
      { id: "gid://shopify/MediaImage/1", alt: "alt1", imageUrl: "url1" },
    ];

    const r1 = computeProductFingerprint(images);
    const r2 = computeProductFingerprint(shuffled);
    assert.equal(r1, r2, "不同顺序应生成相同的指纹");
  }

  /* ================================================================ */
  /*  3. computeProductFingerprint — 字段缺失（alt / imageUrl 为 null）*/
  /* ================================================================ */
  {
    const withNull = [
      { id: "gid://shopify/MediaImage/1", alt: null, imageUrl: null },
    ];
    const result = computeProductFingerprint(withNull);
    const expected = sha256("gid://shopify/MediaImage/1||");
    assert.equal(result, expected, "null 字段应被替换为空字符串");
  }

  /* ================================================================ */
  /*  4. computeProductFingerprint — 标准场景                          */
  /* ================================================================ */
  {
    const images = [
      { id: "gid://shopify/MediaImage/1", alt: "A product photo", imageUrl: "https://cdn.shopify.com/img1.jpg" },
    ];
    const result = computeProductFingerprint(images);
    const expected = sha256("gid://shopify/MediaImage/1|A product photo|https://cdn.shopify.com/img1.jpg");
    assert.equal(result, expected, "标准输入应正确生成指纹");
  }

  /* ================================================================ */
  /*  5. computeProductFingerprint — 相同数据生成相同指纹              */
  /* ================================================================ */
  {
    const images = [
      { id: "gid://shopify/MediaImage/1", alt: "alt", imageUrl: "url" },
    ];
    const r1 = computeProductFingerprint(images);
    const r2 = computeProductFingerprint(images);
    assert.equal(r1, r2, "相同数据应生成相同的指纹");
  }

  /* ================================================================ */
  /*  6. computeCollectionFingerprint — image 为 null                  */
  /* ================================================================ */
  {
    const result = computeCollectionFingerprint(null);
    assert.equal(result, sha256(""), "null 应返回空字符串的 sha256");
  }

  /* ================================================================ */
  /*  7. computeCollectionFingerprint — 标准输入                       */
  /* ================================================================ */
  {
    const image = { url: "https://cdn.shopify.com/collection.jpg", altText: "Collection banner" };
    const result = computeCollectionFingerprint(image);
    const expected = sha256("https://cdn.shopify.com/collection.jpg|Collection banner");
    assert.equal(result, expected, "标准输入应正确生成指纹");
  }

  /* ================================================================ */
  /*  8. computeCollectionFingerprint — altText 为 null                */
  /* ================================================================ */
  {
    const image = { url: "https://cdn.shopify.com/collection.jpg", altText: null };
    const result = computeCollectionFingerprint(image);
    const expected = sha256("https://cdn.shopify.com/collection.jpg|");
    assert.equal(result, expected, "altText 为 null 时应被替换为空字符串");
  }

  /* ================================================================ */
  /*  9. computeCollectionFingerprint — 相同数据生成相同指纹           */
  /* ================================================================ */
  {
    const image = { url: "https://cdn.shopify.com/collection.jpg", altText: "Alt" };
    const r1 = computeCollectionFingerprint(image);
    const r2 = computeCollectionFingerprint(image);
    assert.equal(r1, r2, "相同数据应生成相同的指纹");
  }

  /* ================================================================ */
  /*  10. 空集合指纹与 null 集合指纹一致                                 */
  /* ================================================================ */
  {
    const emptyProduct = computeProductFingerprint([]);
    const nullCollection = computeCollectionFingerprint(null);
    assert.equal(emptyProduct, nullCollection, "空数组与 null 应返回相同空指纹");
  }

  console.log("✅ imageFingerprint 单元测试全部通过");
}

void run().catch((error: unknown) => {
  console.error("❌ imageFingerprint 单元测试失败");
  console.error(error);
  process.exit(1);
});
