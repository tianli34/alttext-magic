import { BULK_QUERY_ARTICLES, BULK_QUERY_COLLECTIONS, BULK_QUERY_FILES, BULK_QUERY_PRODUCT_MEDIA, } from "../../../../app/lib/bulk/queries";
const SCAN_RESOURCE_PRIORITY = [
    "PRODUCT_MEDIA",
    "FILES",
    "COLLECTION_IMAGE",
    "ARTICLE_IMAGE",
];
const BULK_QUERY_BY_RESOURCE_TYPE = {
    PRODUCT_MEDIA: BULK_QUERY_PRODUCT_MEDIA,
    FILES: BULK_QUERY_FILES,
    COLLECTION_IMAGE: BULK_QUERY_COLLECTIONS,
    ARTICLE_IMAGE: BULK_QUERY_ARTICLES,
};
export function buildBulkQueryByResourceType(resourceType) {
    return BULK_QUERY_BY_RESOURCE_TYPE[resourceType];
}
export function compareScanResourcePriority(left, right) {
    return (SCAN_RESOURCE_PRIORITY.indexOf(left) - SCAN_RESOURCE_PRIORITY.indexOf(right));
}
