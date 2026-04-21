/**
 * File: server/modules/scan/catalog/bulk-query-builder.ts
 * Purpose: 统一管理扫描任务资源类型与 Bulk GraphQL 查询的映射，以及提交顺序优先级。
 */
import type { ScanResourceType } from "@prisma/client";
import {
  BULK_QUERY_ARTICLES,
  BULK_QUERY_COLLECTIONS,
  BULK_QUERY_FILES,
  BULK_QUERY_PRODUCT_MEDIA,
} from "../../../../app/lib/bulk/queries";

const SCAN_RESOURCE_PRIORITY: ScanResourceType[] = [
  "PRODUCT_MEDIA",
  "FILES",
  "COLLECTION_IMAGE",
  "ARTICLE_IMAGE",
];

const BULK_QUERY_BY_RESOURCE_TYPE: Record<ScanResourceType, string> = {
  PRODUCT_MEDIA: BULK_QUERY_PRODUCT_MEDIA,
  FILES: BULK_QUERY_FILES,
  COLLECTION_IMAGE: BULK_QUERY_COLLECTIONS,
  ARTICLE_IMAGE: BULK_QUERY_ARTICLES,
};

export function buildBulkQueryByResourceType(
  resourceType: ScanResourceType,
): string {
  return BULK_QUERY_BY_RESOURCE_TYPE[resourceType];
}

export function compareScanResourcePriority(
  left: ScanResourceType,
  right: ScanResourceType,
): number {
  return (
    SCAN_RESOURCE_PRIORITY.indexOf(left) - SCAN_RESOURCE_PRIORITY.indexOf(right)
  );
}
