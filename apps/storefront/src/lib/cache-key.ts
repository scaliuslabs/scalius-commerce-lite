import {
  STOREFRONT_HTML_CACHE_IGNORED_QUERY_PARAMS,
  canonicalizeStorefrontHtmlCachePath,
  normalizeStorefrontCacheQueryValue,
} from "@scalius/shared/storefront-cache-path";

export const HTML_CACHE_IGNORED_QUERY_PARAMS = STOREFRONT_HTML_CACHE_IGNORED_QUERY_PARAMS;

type QueryValue = string | number | boolean | readonly string[] | null | undefined;
type QueryDefaults = Record<string, string | number | boolean>;

function normalizeCanonicalQueryValue(key: string, value: string): string {
  return normalizeStorefrontCacheQueryValue(key, value);
}

function appendSortedParams(
  params: URLSearchParams,
  entries: Array<[string, string]>,
): void {
  entries
    .sort(([aKey, aValue], [bKey, bValue]) => {
      const keyCompare = aKey.localeCompare(bKey);
      return keyCompare === 0 ? aValue.localeCompare(bValue) : keyCompare;
    })
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
  const canonicalUrl = new URL(url.toString());
  const ignored = new Set(ignoredParams);
  const valuesByKey = new Map<string, string>();

  for (const [key, rawValue] of canonicalUrl.searchParams.entries()) {
    const value = normalizeCanonicalQueryValue(key, rawValue);
    if (ignored.has(key)) continue;
    valuesByKey.set(key, value);
  }

  const entries = [...valuesByKey.entries()].filter(([key, value]) => (
    !(dropEmptyValues && value === "") &&
    !(Object.hasOwn(defaultParams, key) && value === String(defaultParams[key]))
  ));
  const canonicalParams = new URLSearchParams();
  appendSortedParams(canonicalParams, entries);
  canonicalUrl.search = canonicalParams.toString();
  canonicalUrl.hash = "";
  return canonicalUrl;
}

export function buildHtmlCacheBaseUrl(url: URL): URL {
  const canonicalPath = canonicalizeStorefrontHtmlCachePath(url.pathname + url.search);
  if (canonicalPath) {
    return new URL(canonicalPath, url.origin);
  }

  return canonicalizeUrlSearchParams(url, {
    ignoredParams: HTML_CACHE_IGNORED_QUERY_PARAMS,
  });
}

export function buildCanonicalQueryString(
  values: Record<string, QueryValue>,
  {
    defaultParams = {},
  }: {
    defaultParams?: QueryDefaults;
  } = {},
): string {
  const entries: Array<[string, string]> = [];

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        const normalizedItem = normalizeCanonicalQueryValue(key, String(item));
        if (normalizedItem !== "") {
          entries.push([key, normalizedItem]);
        }
      }
      continue;
    }

    const normalizedValue = normalizeCanonicalQueryValue(key, String(value));
    if (Object.hasOwn(defaultParams, key) && normalizedValue === String(defaultParams[key])) {
      continue;
    }
    entries.push([key, normalizedValue]);
  }

  const params = new URLSearchParams();
  appendSortedParams(params, entries);
  return params.toString();
}
