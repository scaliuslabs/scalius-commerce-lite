import type { ProductFacet, ProductListOptions } from "@/lib/api";
import {
  STOREFRONT_QUERY_IGNORED_PARAMS,
  buildCanonicalQueryString,
} from "./canonical-query";
import { normalizeSearchQuery } from "./search-query";

const PRODUCT_LIST_NAVIGATION_PARAMS = ["q", "page", "sortBy", "limit"] as const;

/**
 * Products per page. The default stays out of URLs; any other size is a
 * view of the same listing (like a sort), so it is `noindex,follow` and the
 * canonical keeps pointing at the default-size page.
 */
export const PRODUCT_LIST_PAGE_SIZES = [20, 40, 60] as const;
export type ProductListPageSize = (typeof PRODUCT_LIST_PAGE_SIZES)[number];
export const DEFAULT_PRODUCT_LIST_PAGE_SIZE: ProductListPageSize = 20;
/** Keys of the listing URL that choose a view (page, sort, page size), not a filter. */
const PRODUCT_LIST_VIEW_KEYS = new Set(["page", "sortBy", "limit"]);

const PRODUCT_LIST_SORT_VALUES = [
  "relevance",
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
  STOREFRONT_QUERY_IGNORED_PARAMS,
);
const NAVIGATION_PARAM_SET = new Set<string>(PRODUCT_LIST_NAVIGATION_PARAMS);
const SORT_VALUE_SET = new Set<string>(PRODUCT_LIST_SORT_VALUES);
const BOOLEAN_FILTER_SET = new Set<string>(PRODUCT_LIST_BOOLEAN_FILTERS);
const PRICE_FILTER_SET = new Set<string>(PRODUCT_LIST_PRICE_FILTERS);

export type ProductListSort = NonNullable<ProductListOptions["sort"]>;
// Attribute slugs, or merchant option axes as `option.<axis>` (option.size).
const FACET_KEY_PATTERN = /^(?:[a-z0-9][a-z0-9-]{0,79}|option\.[^\s&=#?]{1,80})$/;
// A range facet's bounds: `<attribute slug>.min` and `<attribute slug>.max`.
const RANGE_KEY_PATTERN = /^([a-z0-9][a-z0-9-]{0,79})\.(min|max)$/;

export type ProductListRangeBound = "min" | "max";

/** The URL key of one bound of a range facet (`display-size.min`). */
export function productListRangeKey(slug: string, bound: ProductListRangeBound): string {
  return `${slug}.${bound}`;
}

/** The facet slug and bound a range key names, or null for any other key. */
export function parseProductListRangeKey(key: string): { slug: string; bound: ProductListRangeBound } | null {
  const match = RANGE_KEY_PATTERN.exec(key);
  return match ? { slug: match[1]!, bound: match[2] as ProductListRangeBound } : null;
}

export interface ProductListQueryState {
  page: number;
  /** Products per page (PRODUCT_LIST_PAGE_SIZES). */
  limit: ProductListPageSize;
  sortBy: ProductListSort;
  /** The sort that stays out of URLs: "relevance" for search results, else "newest". */
  defaultSort: ProductListSort;
  query: string;
  options: ProductListOptions;
  currentFilters: ProductListFilterState;
  redirectPath: string | null;
}

export type ProductListFilterState = Record<string, string | string[]>;

/** Filters the buyer applied (search, price, switches, facet values), not page, sort or page size. */
export function countActiveProductListFilters(currentFilters: ProductListFilterState): number {
  return Object.entries(currentFilters)
    .filter(([key, value]) => !PRODUCT_LIST_VIEW_KEYS.has(key) && value)
    .reduce((count, [, value]) => count + (Array.isArray(value) ? value.length : 1), 0);
}

/**
 * Listing views worth indexing: the plain listing and its paginated pages.
 * Sorted, filtered and searched views are `noindex,follow` (Google: paginated
 * pages are indexable and self-canonical; facet/sort permutations are not).
 */
export function isIndexableProductListView(currentFilters: ProductListFilterState): boolean {
  return Object.keys(currentFilters).every((key) => key === "page");
}

/**
 * A page number past the last page does not exist: the listing answers 404
 * instead of an indexable empty page (Google: soft 404s waste crawl budget).
 * Page 1 always exists, so a genuinely empty listing keeps its empty state.
 */
export function isMissingProductListPage(pagination: { page: number; totalPages: number }): boolean {
  return pagination.page > Math.max(1, pagination.totalPages);
}

/**
 * Meta description for a listing the merchant has not described, built from
 * its own products: "Shop Home Refresh: Press Glass Storage Set, Loop
 * Silicone Utensil Set, Echo Mini Speaker and more." Up to three names while
 * it stays within `maxLength` characters.
 */
export function productListMetaDescription(
  name: string,
  productNames: readonly string[],
  maxLength = 155,
): string {
  const names = [...new Set(productNames.map((productName) => productName.trim()).filter(Boolean))];
  const sentence = (shown: readonly string[]) => {
    if (shown.length === 0) return `Shop ${name}.`;
    const list = shown.length < names.length
      ? `${shown.join(", ")} and more`
      : shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
    return `Shop ${name}: ${list}.`;
  };
  let shown: string[] = [];
  for (const productName of names.slice(0, 3)) {
    if (sentence([...shown, productName]).length > maxLength) break;
    shown = [...shown, productName];
  }
  return sentence(shown);
}

/** A listing page's self-canonical URL: the resource URL plus `?page=N` after page 1. */
export function productListCanonicalUrl(resourceUrl: string | null, page: number): string | null {
  if (!resourceUrl) return null;
  if (page <= 1) return resourceUrl;
  const url = new URL(resourceUrl);
  url.search = `page=${page}`;
  return url.toString();
}

export function buildProductListHref({
  pathname,
  currentFilters,
  overrides = {},
  defaultSort = "newest",
}: {
  pathname: string;
  currentFilters: ProductListFilterState;
  overrides?: Record<string, string | number | string[] | null | undefined>;
  defaultSort?: ProductListSort;
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
      sortBy: defaultSort,
      limit: DEFAULT_PRODUCT_LIST_PAGE_SIZE,
    },
  });
  return queryString ? `${pathname}?${queryString}` : pathname;
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

function normalizePageSize(value: string | null): { limit: ProductListPageSize; changed: boolean } {
  if (!value) return { limit: DEFAULT_PRODUCT_LIST_PAGE_SIZE, changed: false };
  const limit = PRODUCT_LIST_PAGE_SIZES.find((size) => String(size) === value);
  // The default size is never written, so `?limit=20` redirects to the clean URL.
  if (!limit || limit === DEFAULT_PRODUCT_LIST_PAGE_SIZE) {
    return { limit: DEFAULT_PRODUCT_LIST_PAGE_SIZE, changed: true };
  }
  return { limit, changed: false };
}

function normalizeSort(
  value: string | null,
  defaultSort: ProductListSort,
): {
  sortBy: ProductListSort;
  changed: boolean;
} {
  if (!value) return { sortBy: defaultSort, changed: false };
  if (SORT_VALUE_SET.has(value) && (value !== "relevance" || defaultSort === "relevance")) {
    return { sortBy: value as ProductListSort, changed: false };
  }
  return { sortBy: defaultSort, changed: true };
}

/** Bangla digits typed into price inputs become Latin digits. */
function latinDigits(value: string | null): string | null {
  return value?.replace(/[\u09e6-\u09ef]/g, (digit) => String(digit.charCodeAt(0) - 0x09e6)) ?? null;
}

function getLastParam(params: URLSearchParams, key: string): string | null {
  const values = params.getAll(key);
  return values.length > 0 ? values[values.length - 1] : null;
}

function collectRenderableParams(
  params: URLSearchParams,
): Map<string, string[]> {
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
    )
      continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function buildAttributeValueMap(
  facets: readonly ProductFacet[],
): Map<string, Set<string>> {
  return new Map(
    facets
      .filter((facet) => facet.display !== "range")
      .map((facet) => [
        facet.slug,
        new Set(facet.values.map(({ value }) => value).filter(Boolean)),
      ]),
  );
}

/**
 * A facet value from the URL as the facet names it. Values are normalised
 * lowercase, so `?brand=Samsung` finds `samsung` (and redirects to it).
 */
function knownFacetValue(allowed: ReadonlySet<string>, candidate: string): string | null {
  if (allowed.has(candidate)) return candidate;
  const lower = candidate.toLowerCase();
  return allowed.has(lower) ? lower : null;
}

/**
 * Validates a listing URL into API options and canonical filter state.
 * `rankByRelevance` (the /search page) makes "relevance" the default sort
 * whenever there is a query; other listings default to "newest".
 */
export function resolveProductListQueryState({
  url,
  facets = [],
  allowUnknownAttributes = false,
  rankByRelevance = false,
}: {
  url: URL;
  facets?: readonly ProductFacet[];
  allowUnknownAttributes?: boolean;
  rankByRelevance?: boolean;
}): ProductListQueryState {
  const params = url.searchParams;
  const rawQuery = getLastParam(params, "q");
  const query = normalizeSearchQuery(rawQuery);
  const defaultSort: ProductListSort = rankByRelevance && query ? "relevance" : "newest";
  const { page, changed: pageChanged } = normalizePage(
    getLastParam(params, "page"),
  );
  const { sortBy, changed: sortChanged } = normalizeSort(
    getLastParam(params, "sortBy"),
    defaultSort,
  );
  const { limit, changed: limitChanged } = normalizePageSize(getLastParam(params, "limit"));
  const renderParams = collectRenderableParams(params);
  const attributeValues = buildAttributeValueMap(facets);
  const rangeFacetSlugs = new Set(facets.filter((facet) => facet.display === "range").map((facet) => facet.slug));
  const ranges = new Map<string, Partial<Record<ProductListRangeBound, number>>>();
  const options: ProductListOptions = {
    page,
    limit,
    sort: sortBy,
  };
  const currentFilters: ProductListFilterState = {};
  let shouldRedirect =
    pageChanged || sortChanged || limitChanged || hasRepeatedSingletonParams(params);

  if (query) {
    options.search = query;
    currentFilters.q = query;
  } else if (params.has("q")) {
    shouldRedirect = true;
  }
  if (page > 1) {
    currentFilters.page = String(page);
  }
  if (sortBy !== defaultSort) {
    currentFilters.sortBy = sortBy;
  }
  if (limit !== DEFAULT_PRODUCT_LIST_PAGE_SIZE) {
    currentFilters.limit = String(limit);
  }

  const minPriceParam = latinDigits(getLastParam(params, "minPrice"));
  const maxPriceParam = latinDigits(getLastParam(params, "maxPrice"));
  if (
    minPriceParam !== getLastParam(params, "minPrice") ||
    maxPriceParam !== getLastParam(params, "maxPrice")
  ) {
    shouldRedirect = true;
  }
  let minPrice = minPriceParam === null ? undefined : Number(minPriceParam);
  let maxPrice = maxPriceParam === null ? undefined : Number(maxPriceParam);
  if (
    minPrice !== undefined &&
    (!minPriceParam ||
      !Number.isFinite(minPrice) ||
      minPrice <= 0)
  ) {
    minPrice = undefined;
    shouldRedirect = true;
  }
  if (
    maxPrice !== undefined &&
    (!maxPriceParam ||
      !Number.isFinite(maxPrice) ||
      maxPrice < 0)
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
    // One bound of a range facet: a single plain number (Bangla digits read
    // as Latin). Anything else, including the empty fields a form without
    // JavaScript submits, redirects to the clean URL.
    const range = parseProductListRangeKey(key);
    if (range && (rangeFacetSlugs.has(range.slug) || allowUnknownAttributes)) {
      const raw = rawValues.at(-1)!.trim();
      const latin = latinDigits(raw)!;
      const number = latin ? Number(latin) : Number.NaN;
      if (rawValues.length !== 1 || !Number.isFinite(number) || String(number) !== raw) {
        shouldRedirect = true;
      }
      if (Number.isFinite(number)) ranges.set(range.slug, { ...ranges.get(range.slug), [range.bound]: number });
      continue;
    }

    const values = Array.from(
      new Set(rawValues.map((value) => value.trim()).filter(Boolean)),
    );
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
    const knownValues = allowedValues
      ? values.map((candidate) => knownFacetValue(allowedValues, candidate))
      : [];
    const validValues = Array.from(
      new Set(knownValues.filter((candidate): candidate is string => candidate !== null)),
    );
    if (validValues.length > 0) {
      if (validValues.length !== values.length || knownValues.some((known, index) => known !== values[index])) {
        shouldRedirect = true;
      }
      options[key] = validValues;
      currentFilters[key] = validValues;
      continue;
    }

    if (allowUnknownAttributes && FACET_KEY_PATTERN.test(key) && values.length > 0) {
      options[key] = values;
      currentFilters[key] = values;
      continue;
    }

    shouldRedirect = true;
  }

  for (const [slug, bounds] of ranges) {
    let { min, max } = bounds;
    if (min !== undefined && max !== undefined && min > max) {
      [min, max] = [max, min];
      shouldRedirect = true;
    }
    for (const [bound, number] of [["min", min], ["max", max]] as const) {
      if (number === undefined) continue;
      const key = productListRangeKey(slug, bound);
      options[key] = number;
      currentFilters[key] = String(number);
    }
  }

  if (!shouldRedirect) {
    return { page, limit, sortBy, defaultSort, query, options, currentFilters, redirectPath: null };
  }

  return {
    page,
    limit,
    sortBy,
    defaultSort,
    query,
    options,
    currentFilters,
    redirectPath: buildProductListHref({ pathname: url.pathname, currentFilters, defaultSort }),
  };
}
