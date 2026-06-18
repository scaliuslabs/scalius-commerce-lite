import type { FilterableAttribute, ProductListOptions } from "@/lib/api";
import { HTML_CACHE_IGNORED_QUERY_PARAMS, buildCanonicalQueryString } from "./cache-key";
import {
  DEFAULT_MAX_PRICE,
  DEFAULT_MIN_PRICE,
  parsePriceFilterValue,
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
  currentFilters: Record<string, string>;
  redirectPath: string | null;
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

function buildAttributeValueMap(
  attributes: readonly FilterableAttribute[],
): Map<string, Set<string>> {
  return new Map(
    attributes.map((attribute) => [
      attribute.slug,
      new Set(attribute.values.filter(Boolean)),
    ]),
  );
}

function appendCanonicalFilterParams(
  canonical: URLSearchParams,
  currentFilters: Record<string, string>,
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
  attributes = [],
}: {
  url: URL;
  attributes?: readonly FilterableAttribute[];
}): ProductListQueryState {
  const params = url.searchParams;
  const query = normalizeSearchQuery(params.get("q"));
  const { page, changed: pageChanged } = normalizePage(params.get("page"));
  const { sortBy, changed: sortChanged } = normalizeSort(params.get("sortBy"));
  const attributeValues = buildAttributeValueMap(attributes);
  const options: ProductListOptions = {
    page,
    limit: 20,
    sort: sortBy,
  };
  const currentFilters: Record<string, string> = {};
  let shouldRedirect = pageChanged || sortChanged;

  if (query) {
    options.search = query;
    currentFilters.q = query;
  } else if (params.has("q") && params.get("q")) {
    shouldRedirect = true;
  }
  if (page > 1) {
    currentFilters.page = String(page);
  }
  if (sortBy !== "newest") {
    currentFilters.sortBy = sortBy;
  }

  const minPrice = parsePriceFilterValue(
    params.get("minPrice") ?? undefined,
    DEFAULT_MIN_PRICE,
  );
  const maxPrice = parsePriceFilterValue(
    params.get("maxPrice") ?? undefined,
    DEFAULT_MAX_PRICE,
  );
  if (params.has("minPrice") && minPrice <= DEFAULT_MIN_PRICE) {
    shouldRedirect = true;
  }
  if (
    params.has("maxPrice") &&
    maxPrice === DEFAULT_MAX_PRICE &&
    minPrice <= DEFAULT_MIN_PRICE
  ) {
    shouldRedirect = true;
  }
  if (minPrice > DEFAULT_MIN_PRICE) {
    options.minPrice = minPrice;
    currentFilters.minPrice = String(minPrice);
  }
  if (maxPrice !== DEFAULT_MAX_PRICE || minPrice > DEFAULT_MIN_PRICE) {
    options.maxPrice = maxPrice;
    currentFilters.maxPrice = String(maxPrice);
  }

  for (const [key, value] of params.entries()) {
    if (!value) continue;
    if (IGNORED_PRODUCT_LIST_QUERY_PARAMS.has(key)) continue;
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
    if (allowedValues?.has(value)) {
      options[key] = value;
      currentFilters[key] = value;
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
