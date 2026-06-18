export const HTML_CACHE_IGNORED_QUERY_PARAMS = [
  "fbclid",
  "gclid",
  "msclkid",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
] as const;

const PRODUCT_HTML_IGNORED_QUERY_PARAMS = ["size", "color"] as const;

type QueryValue = string | number | boolean | readonly string[] | null | undefined;
type QueryDefaults = Record<string, string | number | boolean>;

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
  const entries: Array<[string, string]> = [];

  for (const [key, value] of canonicalUrl.searchParams.entries()) {
    if (ignored.has(key)) continue;
    if (dropEmptyValues && value === "") continue;
    if (Object.hasOwn(defaultParams, key) && value === String(defaultParams[key])) {
      continue;
    }
    entries.push([key, value]);
  }

  const canonicalParams = new URLSearchParams();
  appendSortedParams(canonicalParams, entries);
  canonicalUrl.search = canonicalParams.toString();
  return canonicalUrl;
}

export function buildHtmlCacheBaseUrl(url: URL): URL {
  const ignoredParams: string[] = [...HTML_CACHE_IGNORED_QUERY_PARAMS];
  const defaultParams: QueryDefaults = {};
  if (/^\/products\/[^/]+$/.test(url.pathname)) {
    ignoredParams.push(...PRODUCT_HTML_IGNORED_QUERY_PARAMS);
  }
  if (/^\/categories\/[^/]+$/.test(url.pathname) || /^\/search\/?$/.test(url.pathname)) {
    defaultParams.page = 1;
    defaultParams.sortBy = "newest";
  }

  return canonicalizeUrlSearchParams(url, { defaultParams, ignoredParams });
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
        if (item !== "") {
          entries.push([key, String(item)]);
        }
      }
      continue;
    }

    if (Object.hasOwn(defaultParams, key) && String(value) === String(defaultParams[key])) {
      continue;
    }
    entries.push([key, String(value)]);
  }

  const params = new URLSearchParams();
  appendSortedParams(params, entries);
  return params.toString();
}
