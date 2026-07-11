import type { ProductFacet, ProductListOptions } from "@/lib/api";
import { HTML_CACHE_IGNORED_QUERY_PARAMS, buildCanonicalQueryString } from "./cache-key";
import {
  DEFAULT_MIN_PRICE,
} from "./filters/price-url";
import { normalizeSearchQuery } from "./search-query";

export const PRODUCT_LIST_NAVIGATION_PARAMS = ["q", "page", "sortBy"] as const;

const PRODUCT_LIST_SORT_VALUES = [
  "newest",
  "price-asc",
  "price-desc",
  "name-asc",
  "name-desc",
  "discount",
] as const satisfies NonNullable<ProductListOptions["sort"]>[];

const PRODUCT_LIST_BOOLEAN_FILTERS = ["freeDelivery", "hasDiscount"] as const;
const PRODUCT_LIST_PRICE_FILTERS = ["minPrice", "maxPrice"] as const;

const IGNORED_PRODUCT_LIST_QUERY_PARAMS = new Set<string>(
  HTML_CACHE_IGNORED_QUERY_PARAMS,
);
const NAVIGATION_PARAM_SET = new Set<string>(PRODUCT_LIST_NAVIGATION_PARAMS);
const SORT_VALUE_SET = new Set<string>(PRODUCT_LIST_SORT_VALUES);
const BOOLEAN_FILTER_SET = new Set<string>(PRODUCT_LIST_BOOLEAN_FILTERS);
const PRICE_FILTER_SET = new Set<string>(PRODUCT_LIST_PRICE_FILTERS);

type ProductListSort = NonNullable<ProductListOptions["sort"]>;

export interface ProductListQueryState {
  page: number;
  sortBy: ProductListSort;
  query: string;
  options: ProductListOptions;
  currentFilters: ProductListFilterState;
  redirectPath: string | null;
}

export type ProductListFilterState = Record<string, string | string[]>;

export function buildProductListHref({
  pathname,
  currentFilters,
  overrides = {},
}: {
  pathname: string;
  currentFilters: ProductListFilterState;
  overrides?: Record<string, string | number | null | undefined>;
}): string {
  const nextFilters: Record<string, string | number | string[]> = {
    ...currentFilters,
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined || value === "") {
      delete nextFilters[key];
    } else {
      nextFilters[key] = value;
    }
  }

  if (Number(nextFilters.page ?? 1) <= 1) {
    delete nextFilters.page;
  }

  const queryString = buildCanonicalQueryString(nextFilters, {
    defaultParams: {
      page: 1,
      sortBy: "newest",
    },
  });
  return queryString ? `${pathname}?${queryString}` : pathname;
}

export function buildProductListPaginationHref({
  pathname,
  currentFilters,
  page,
}: {
  pathname: string;
  currentFilters: ProductListFilterState;
  page: number;
}): string {
  return buildProductListHref({
    pathname,
    currentFilters,
    overrides: { page },
  });
}

export function hasDynamicProductListFilterParams(
  params: URLSearchParams,
): boolean {
  for (const [key, value] of params.entries()) {
    if (!value) continue;
    if (IGNORED_PRODUCT_LIST_QUERY_PARAMS.has(key)) continue;
    if (NAVIGATION_PARAM_SET.has(key)) continue;
    if (BOOLEAN_FILTER_SET.has(key)) continue;
    if (PRICE_FILTER_SET.has(key)) continue;
    return true;
  }
  return false;
}

function normalizePage(value: string | null): {
  page: number;
  changed: boolean;
} {
  if (!value) return { page: 1, changed: false };

  const page = Number.parseInt(value, 10);
  if (!Number.isFinite(page) || page < 1 || String(page) !== value) {
    return { page: 1, changed: true };
  }
  return { page, changed: false };
}

function normalizeSort(value: string | null): {
  sortBy: ProductListSort;
  changed: boolean;
} {
  if (!value) return { sortBy: "newest", changed: false };
  if (SORT_VALUE_SET.has(value)) {
    return { sortBy: value as ProductListSort, changed: false };
  }
  return { sortBy: "newest", changed: true };
}

function getLastParam(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length > 0 ? values[values.length - 1] : null;
}

function collectRenderableParams(params: URLSearchParams): Map<string, string[]> {
  const valuesByKey = new Map<string, string[]>();
  for (const [key, value] of params.entries()) {
    if (IGNORED_PRODUCT_LIST_QUERY_PARAMS.has(key)) continue;
    const values = valuesByKey.get(key) ?? [];
    values.push(value);
    valuesByKey.set(key, values);
  }
  return valuesByKey;
}

function hasRepeatedSingletonParams(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const [key] of params.entries()) {
    if (IGNORED_PRODUCT_LIST_QUERY_PARAMS.has(key)) continue;
    if (
      !NAVIGATION_PARAM_SET.has(key) &&
      !BOOLEAN_FILTER_SET.has(key) &&
      !PRICE_FILTER_SET.has(key)
    ) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function buildAttributeValueMap(
  facets: readonly ProductFacet[],
): Map<string, Set<string>> {
  return new Map(
    facets.map((facet) => [
      facet.slug,
      new Set(facet.values.map(({ value }) => value).filter(Boolean)),
    ]),
  );
}

function appendCanonicalFilterParams(
  canonical: URLSearchParams,
  currentFilters: ProductListFilterState,
): void {
  const queryString = buildCanonicalQueryString(currentFilters, {
    defaultParams: {
      page: 1,
      sortBy: "newest",
    },
  });
  for (const [key, value] of new URLSearchParams(queryString).entries()) {
    canonical.append(key, value);
  }
}

export function resolveProductListQueryState({
  url,
  facets = [],
  allowUnknownAttributes = false,
}: {
  url: URL;
  facets?: readonly ProductFacet[];
  allowUnknownAttributes?: boolean;
}): ProductListQueryState {
  const params = url.searchParams;
  const rawQuery = getLastParam(params, "q");
  const query = normalizeSearchQuery(rawQuery);
  const { page, changed: pageChanged } = normalizePage(getLastParam(params, "page"));
  const { sortBy, changed: sortChanged } = normalizeSort(getLastParam(params, "sortBy"));
  const renderParams = collectRenderableParams(params);
  const attributeValues = buildAttributeValueMap(facets);
  const options: ProductListOptions = {
    page,
    limit: 20,
    sort: sortBy,
  };
  const currentFilters: ProductListFilterState = {};
  let shouldRedirect =
    pageChanged ||
    sortChanged ||
    hasRepeatedSingletonParams(params);

  if (query) {
    options.search = query;
    currentFilters.q = query;
  } else if (params.has("q")) {
    shouldRedirect = true;
  }
  if (page > 1) {
    currentFilters.page = String(page);
  }
  if (sortBy !== "newest") {
    currentFilters.sortBy = sortBy;
  }

  const minPriceParam = getLastParam(params, "minPrice");
  const maxPriceParam = getLastParam(params, "maxPrice");
  let minPrice = minPriceParam === null ? undefined : Number(minPriceParam);
  let maxPrice = maxPriceParam === null ? undefined : Number(maxPriceParam);
  if (
    minPrice !== undefined &&
    (!minPriceParam || !Number.isFinite(minPrice) || minPrice <= DEFAULT_MIN_PRICE)
  ) {
    minPrice = undefined;
    shouldRedirect = true;
  }
  if (
    maxPrice !== undefined &&
    (!maxPriceParam || !Number.isFinite(maxPrice) || maxPrice < DEFAULT_MIN_PRICE)
  ) {
    maxPrice = undefined;
    shouldRedirect = true;
  }
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    [minPrice, maxPrice] = [maxPrice, minPrice];
    shouldRedirect = true;
  }
  if (minPrice !== undefined) {
    options.minPrice = minPrice;
    currentFilters.minPrice = String(minPrice);
  }
  if (maxPrice !== undefined) {
    options.maxPrice = maxPrice;
    currentFilters.maxPrice = String(maxPrice);
  }

  for (const [key, rawValues] of renderParams.entries()) {
    const values = Array.from(new Set(
      rawValues.map((value) => value.trim()).filter(Boolean),
    ));
    const value = values.at(-1);
    if (!value) continue;
    if (NAVIGATION_PARAM_SET.has(key) || PRICE_FILTER_SET.has(key)) continue;

    if (BOOLEAN_FILTER_SET.has(key)) {
      if (value === "true") {
        options[key] = true;
        currentFilters[key] = "true";
      } else {
        shouldRedirect = true;
      }
      continue;
    }

    const allowedValues = attributeValues.get(key);
    const validValues = allowedValues
      ? values.filter((candidate) => allowedValues.has(candidate))
      : [];
    if (validValues.length > 0) {
      if (validValues.length !== values.length) {
        shouldRedirect = true;
      }
      options[key] = validValues;
      currentFilters[key] = validValues;
      continue;
    }

    if (
      allowUnknownAttributes &&
      /^[a-z0-9][a-z0-9-]{0,79}$/.test(key) &&
      values.length > 0
    ) {
      options[key] = values;
      currentFilters[key] = values;
      continue;
    }

    shouldRedirect = true;
  }

  if (!shouldRedirect) {
    return {
      page,
      sortBy,
      query,
      options,
      currentFilters,
      redirectPath: null,
    };
  }

  const canonicalUrl = new URL(url.toString());
  const canonicalParams = new URLSearchParams();
  appendCanonicalFilterParams(canonicalParams, currentFilters);
  canonicalUrl.search = canonicalParams.toString();

  return {
    page,
    sortBy,
    query,
    options,
    currentFilters,
    redirectPath:
      canonicalUrl.pathname + canonicalUrl.search + canonicalUrl.hash,
  };
}
