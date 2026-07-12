/**
 * Public product response cache contract.
 *
 * Bump this namespace whenever the serialized storefront product envelope
 * changes incompatibly. Old KV entries then expire naturally without ever
 * being read by the new runtime.
 */
export const PRODUCT_API_CACHE_NAMESPACE = "api:products:v2:";

const PRODUCT_API_ROUTE_PATH = "/api/v1/products";

export function getProductApiCacheKey(routeSuffix = ""): string {
  const normalizedSuffix =
    routeSuffix === "" || routeSuffix.startsWith("/")
      ? routeSuffix
      : `/${routeSuffix}`;
  return `${PRODUCT_API_CACHE_NAMESPACE}${PRODUCT_API_ROUTE_PATH}${normalizedSuffix}`;
}

export function getProductApiQueryCachePattern(routeSuffix = ""): string {
  return `${getProductApiCacheKey(routeSuffix)}?*`;
}
