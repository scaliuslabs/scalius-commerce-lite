/**
 * Ad-click and campaign parameters. No storefront page reads them on the
 * server: they stay in the browser URL for client analytics, but they never
 * split the page cache, reach a render, or appear in a canonical link.
 * A fixed allowlist (plus every `utm_*`): an unknown parameter is kept,
 * because it may be functional.
 */
const TRACKING_QUERY_PARAMS = [
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "gad_source",
  "gad_campaignid",
  "srsltid",
  "msclkid",
  "ttclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "_ga",
  "ref",
] as const;

const TRACKING_QUERY_PARAM_SET = new Set<string>(TRACKING_QUERY_PARAMS);

/** Whether a query key is an ad-click or campaign parameter (see above). */
export function isStorefrontTrackingQueryParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return TRACKING_QUERY_PARAM_SET.has(normalized) || normalized.startsWith("utm_");
}

const PRODUCT_HTML_IGNORED_QUERY_PARAMS = ["size", "color"] as const;

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

function getHtmlPathDefaults(
  pathname: string,
): Record<string, string | number> {
  if (
    /^\/categories\/[^/]+$/.test(pathname) ||
    /^\/collections\/[^/]+$/.test(pathname) ||
    /^\/blog\/?$/.test(pathname) ||
    /^\/search\/?$/.test(pathname)
  ) {
    return { page: 1, sortBy: "newest" };
  }
  return {};
}

export function hasStorefrontProductVariantSelectionParams(url: URL): boolean {
  return (
    /^\/products\/[^/]+$/.test(url.pathname) &&
    PRODUCT_HTML_IGNORED_QUERY_PARAMS.some((param) =>
      url.searchParams.has(param),
    )
  );
}

function getIgnoredParams(pathname: string): (key: string) => boolean {
  const productParams = /^\/products\/[^/]+$/.test(pathname)
    ? new Set<string>(PRODUCT_HTML_IGNORED_QUERY_PARAMS)
    : null;
  return (key) => isStorefrontTrackingQueryParam(key) || Boolean(productParams?.has(key));
}

export function canonicalizeStorefrontHtmlCachePath(
  path: string,
): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(path, "https://storefront-cache.local");
  } catch {
    return null;
  }

  const ignored = getIgnoredParams(url.pathname);
  const defaults = getHtmlPathDefaults(url.pathname);
  const entries: Array<[string, string]> = [];

  for (const [key, rawValue] of url.searchParams.entries()) {
    if (ignored(key)) continue;
    const value = normalizeStorefrontCacheQueryValue(key, rawValue);
    entries.push([key, value]);
  }

  const filteredEntries = entries.filter(
    ([key, value]) =>
      value !== "" &&
      !(Object.hasOwn(defaults, key) && value === String(defaults[key])),
  );
  const params = new URLSearchParams();
  appendSortedParams(params, filteredEntries);
  const query = params.toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}
