import {
  STOREFRONT_HTML_CACHE_IGNORED_QUERY_PARAMS,
  normalizeStorefrontCacheQueryValue,
} from "@scalius/shared/storefront-cache-path";

export const STOREFRONT_QUERY_IGNORED_PARAMS =
  STOREFRONT_HTML_CACHE_IGNORED_QUERY_PARAMS;

type QueryValue =
  | string
  | number
  | boolean
  | readonly string[]
  | null
  | undefined;
type QueryDefaults = Record<string, string | number | boolean>;

function appendSortedParams(
  params: URLSearchParams,
  entries: Array<[string, string]>,
): void {
  entries
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .forEach(([key, value]) => params.append(key, value));
}

export function canonicalizeUrlSearchParams(
  url: URL,
  {
    defaultParams = {},
    ignoredParams = [],
    dropEmptyValues = true,
  }: {
    defaultParams?: QueryDefaults;
    ignoredParams?: readonly string[];
    dropEmptyValues?: boolean;
  } = {},
): URL {
  const canonicalUrl = new URL(url);
  const ignored = new Set(ignoredParams);
  const entries: Array<[string, string]> = [];
  for (const [key, rawValue] of canonicalUrl.searchParams) {
    const value = normalizeStorefrontCacheQueryValue(key, rawValue);
    if (
      ignored.has(key) ||
      (dropEmptyValues && value === "") ||
      (Object.hasOwn(defaultParams, key) && value === String(defaultParams[key]))
    ) {
      continue;
    }
    entries.push([key, value]);
  }

  const params = new URLSearchParams();
  appendSortedParams(params, entries);
  canonicalUrl.search = params.toString();
  canonicalUrl.hash = "";
  return canonicalUrl;
}

export function buildCanonicalQueryString(
  values: Record<string, QueryValue>,
  { defaultParams = {} }: { defaultParams?: QueryDefaults } = {},
): string {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      const normalized = normalizeStorefrontCacheQueryValue(key, String(item));
      if (
        normalized !== "" &&
        (!Object.hasOwn(defaultParams, key) ||
          normalized !== String(defaultParams[key]))
      ) {
        entries.push([key, normalized]);
      }
    }
  }

  const params = new URLSearchParams();
  appendSortedParams(params, entries);
  return params.toString();
}
