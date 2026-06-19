const TRACKING_QUERY_PARAMS = [
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

export const STOREFRONT_HTML_CACHE_IGNORED_QUERY_PARAMS = TRACKING_QUERY_PARAMS;

export function normalizeStorefrontCacheQueryValue(
  key: string,
  value: string,
): string {
  if (key !== "q" && key !== "search") return value;
  return value.trim().replace(/\s+/g, " ");
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

function getHtmlPathDefaults(pathname: string): Record<string, string | number> {
  if (/^\/categories\/[^/]+$/.test(pathname) || /^\/search\/?$/.test(pathname)) {
    return { page: 1, sortBy: "newest" };
  }
  return {};
}

function getIgnoredParams(pathname: string): Set<string> {
  const ignored = new Set<string>(TRACKING_QUERY_PARAMS);
  if (/^\/products\/[^/]+$/.test(pathname)) {
    PRODUCT_HTML_IGNORED_QUERY_PARAMS.forEach((param) => ignored.add(param));
  }
  return ignored;
}

export function canonicalizeStorefrontHtmlCachePath(path: string): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(path, "https://storefront-cache.local");
  } catch {
    return null;
  }

  const ignored = getIgnoredParams(url.pathname);
  const defaults = getHtmlPathDefaults(url.pathname);
  const valuesByKey = new Map<string, string>();

  for (const [key, rawValue] of url.searchParams.entries()) {
    if (ignored.has(key)) continue;
    const value = normalizeStorefrontCacheQueryValue(key, rawValue);
    valuesByKey.set(key, value);
  }

  const entries = [...valuesByKey.entries()].filter(([key, value]) => (
    value !== "" &&
    !(Object.hasOwn(defaults, key) && value === String(defaults[key]))
  ));
  const params = new URLSearchParams();
  appendSortedParams(params, entries);
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function normalizeStorefrontHtmlCachePaths(
  paths: readonly string[],
  maxPaths: number,
): string[] {
  const uniquePaths: string[] = [];
  const seen = new Set<string>();

  for (const rawPath of paths) {
    const path = canonicalizeStorefrontHtmlCachePath(rawPath);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    uniquePaths.push(path);
    if (uniquePaths.length >= maxPaths) break;
  }

  return uniquePaths;
}
