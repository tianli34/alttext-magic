/**
 * File: tests/scope-utils.test.ts
 * Purpose: Verify scope flag validation and canonical normalization helpers.
 */
import assert from "node:assert/strict";

import {
  dedupeScopeFlags,
  isScopeFlag,
  normalizeScopeFlags,
  parseScopeFlags,
  safeParseScopeFlags,
  sortScopeFlags,
  type ScopeFlag,
} from "../app/lib/scope-utils";

function run(): void {
  assert.equal(isScopeFlag("PRODUCT_MEDIA"), true);
  assert.equal(isScopeFlag("UNKNOWN_SCOPE"), false);
  assert.equal(isScopeFlag(1), false);

  const duplicateFlags: ScopeFlag[] = [
    "FILES",
    "PRODUCT_MEDIA",
    "FILES",
    "ARTICLE_IMAGE",
    "PRODUCT_MEDIA",
  ];

  assert.deepEqual(dedupeScopeFlags(duplicateFlags), [
    "FILES",
    "PRODUCT_MEDIA",
    "ARTICLE_IMAGE",
  ]);

  const unsortedFlags: ScopeFlag[] = [
    "ARTICLE_IMAGE",
    "PRODUCT_MEDIA",
    "COLLECTION_IMAGE",
    "FILES",
  ];

  assert.deepEqual(sortScopeFlags(unsortedFlags), [
    "PRODUCT_MEDIA",
    "FILES",
    "COLLECTION_IMAGE",
    "ARTICLE_IMAGE",
  ]);

  const mixedFlags: ScopeFlag[] = [
    "ARTICLE_IMAGE",
    "FILES",
    "PRODUCT_MEDIA",
    "FILES",
    "ARTICLE_IMAGE",
  ];

  assert.deepEqual(normalizeScopeFlags(mixedFlags), [
    "PRODUCT_MEDIA",
    "FILES",
    "ARTICLE_IMAGE",
  ]);

  assert.deepEqual(
    parseScopeFlags([
      "ARTICLE_IMAGE",
      "FILES",
      "PRODUCT_MEDIA",
      "FILES",
    ]),
    ["PRODUCT_MEDIA", "FILES", "ARTICLE_IMAGE"],
  );

  assert.throws(() => parseScopeFlags(["INVALID_SCOPE"]));

  const successResult = safeParseScopeFlags([
    "COLLECTION_IMAGE",
    "PRODUCT_MEDIA",
    "COLLECTION_IMAGE",
  ]);

  assert.equal(successResult.success, true);

  if (successResult.success) {
    assert.deepEqual(successResult.data, [
      "PRODUCT_MEDIA",
      "COLLECTION_IMAGE",
    ]);
  }

  const failureResult = safeParseScopeFlags(["INVALID_SCOPE"]);

  assert.equal(failureResult.success, false);
}

run();
