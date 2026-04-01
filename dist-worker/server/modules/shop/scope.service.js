const PRODUCTS_FLAG = 1 << 0;
const FILES_FLAG = 1 << 1;
const COLLECTIONS_FLAG = 1 << 2;
const ARTICLES_FLAG = 1 << 3;
export const DEFAULT_SCAN_SCOPE_FLAGS = {
    products: true,
    files: true,
    collections: true,
    articles: true,
};
export function encodeScanScopeFlags(flags) {
    let encoded = 0;
    if (flags.products) {
        encoded |= PRODUCTS_FLAG;
    }
    if (flags.files) {
        encoded |= FILES_FLAG;
    }
    if (flags.collections) {
        encoded |= COLLECTIONS_FLAG;
    }
    if (flags.articles) {
        encoded |= ARTICLES_FLAG;
    }
    return encoded;
}
