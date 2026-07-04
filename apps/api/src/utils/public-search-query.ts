import { sanitizeFtsQuery } from "@scalius/core/search";

export const INVALID_PUBLIC_FTS_CACHE_VALUE = "__scalius_invalid_fts_query__";

export function normalizePublicSearchQuery(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizePublicFtsSearchQuery(value: string | null | undefined): string {
  const normalized = normalizePublicSearchQuery(value);
  return sanitizeFtsQuery(normalized) ? normalized : "";
}

export function normalizePublicFtsSearchCacheValue(value: string | null | undefined): string {
  const normalized = normalizePublicSearchQuery(value);
  if (!normalized) return "";
  return sanitizeFtsQuery(normalized) ? normalized : INVALID_PUBLIC_FTS_CACHE_VALUE;
}

export function normalizePublicIntegerCacheValue(value: string): string {
  const normalized = value.trim();
  return /^\d+$/.test(normalized) ? String(Number(normalized)) : normalized;
}

export function normalizePublicNumberCacheValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) return normalized;

  const numericValue = Number(normalized);
  return Number.isFinite(numericValue) ? String(numericValue) : normalized;
}

export function normalizePublicListingSearchParam(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = normalizePublicSearchQuery(value);
  if (!normalized) return undefined;
  return sanitizeFtsQuery(normalized) ? normalized : normalized;
}

function hasNoEmptyQueryValuesExcept(url: string, allowedKeys: ReadonlySet<string>): boolean {
  for (const [key, value] of new URL(url).searchParams.entries()) {
    if (value === "" && !allowedKeys.has(key)) return false;
  }
  return true;
}

function hasOptionalIntegerQueryParamInRange(
  url: string,
  key: string,
  min: number,
  max: number,
): boolean {
  const params = new URL(url).searchParams;
  if (!params.has(key)) return true;

  const value = params.get(key)?.trim() ?? "";
  if (!/^\d+$/.test(value)) return false;

  const numericValue = Number(value);
  return numericValue >= min && numericValue <= max;
}

function hasOptionalFiniteNumberQueryParam(url: string, key: string): boolean {
  const params = new URL(url).searchParams;
  if (!params.has(key)) return true;

  const value = params.get(key)?.trim() ?? "";
  return value !== "" && Number.isFinite(Number(value));
}

function hasOptionalEnumQueryParam(
  url: string,
  key: string,
  allowedValues: ReadonlySet<string>,
): boolean {
  const params = new URL(url).searchParams;
  if (!params.has(key)) return true;

  const value = params.get(key);
  return value !== null && allowedValues.has(value);
}

const BOOLEAN_QUERY_VALUES = new Set(["true", "false"]);
const PUBLIC_SORT_VALUES = new Set([
  "newest",
  "price-asc",
  "price-desc",
  "name-asc",
  "name-desc",
  "discount",
]);

export function isPublicSearchCacheable(url: string): boolean {
  return (
    hasNoEmptyQueryValuesExcept(url, new Set(["q"])) &&
    hasOptionalIntegerQueryParamInRange(url, "limit", 1, 50) &&
    hasOptionalFiniteNumberQueryParam(url, "minPrice") &&
    hasOptionalFiniteNumberQueryParam(url, "maxPrice") &&
    hasOptionalEnumQueryParam(url, "searchPages", BOOLEAN_QUERY_VALUES) &&
    hasOptionalEnumQueryParam(url, "searchCategories", BOOLEAN_QUERY_VALUES)
  );
}

export function isPublicProductListCacheable(url: string): boolean {
  return (
    hasNoEmptyQueryValuesExcept(url, new Set(["search"])) &&
    hasOptionalIntegerQueryParamInRange(url, "page", 1, 1000) &&
    hasOptionalIntegerQueryParamInRange(url, "limit", 1, 100) &&
    hasOptionalFiniteNumberQueryParam(url, "minPrice") &&
    hasOptionalFiniteNumberQueryParam(url, "maxPrice") &&
    hasOptionalEnumQueryParam(url, "sort", PUBLIC_SORT_VALUES) &&
    hasOptionalEnumQueryParam(url, "freeDelivery", BOOLEAN_QUERY_VALUES) &&
    hasOptionalEnumQueryParam(url, "hasDiscount", BOOLEAN_QUERY_VALUES)
  );
}

export function isPublicProductSearchCacheable(url: string): boolean {
  return (
    hasNoEmptyQueryValuesExcept(url, new Set(["search"])) &&
    hasOptionalIntegerQueryParamInRange(url, "page", 1, 1000) &&
    hasOptionalIntegerQueryParamInRange(url, "limit", 1, 100)
  );
}
