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
  // Read-your-writes (`STOREFRONT_SEEN_SEQ_PARAM`): the gateway reads it before
  // the key is built; it never splits the cache or reaches a render.
  "_sv",
] as const;

/**
 * `_sv=<seq>` on a dashboard "view on store" link: the store clock after the
 * merchant's write (`X-Scalius-Commit-Seq`). A dependency-validated hit is
 * checked against a frontier at least that new, so the merchant sees their
 * own change at once (CACHE-DESIGN §6.10).
 */
export const STOREFRONT_SEEN_SEQ_PARAM = "_sv";

/** The `_sv` clock value a request carries, or null (absent or malformed). */
export function readStorefrontSeenSeq(url: URL): number | null {
  const raw = url.searchParams.get(STOREFRONT_SEEN_SEQ_PARAM);
  if (raw === null || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/** `url` with `_sv` set to the clock value a write answered (`X-Scalius-Commit-Seq`). */
export function withStorefrontSeenSeq(url: string, seq: number | null | undefined): string {
  if (seq === null || seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return url;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const next = new URL(url, "https://relative.invalid");
    next.searchParams.set(STOREFRONT_SEEN_SEQ_PARAM, String(seq));
    return absolute ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
  } catch {
    return url;
  }
}

const TRACKING_QUERY_PARAM_SET = new Set<string>(TRACKING_QUERY_PARAMS);

/** Whether a query key is an ad-click or campaign parameter (see above). */
export function isStorefrontTrackingQueryParam(key: string): boolean {
  const normalized = key.toLowerCase();
  return TRACKING_QUERY_PARAM_SET.has(normalized) || normalized.startsWith("utm_");
}

/**
 * Variant selection on a product page: `variant=<sku id>` (feed rows, shared
 * links, the buy box's own URL) and the retired `size`/`color` links. The
 * server renders one page per product whatever they say, and a pre-paint
 * script in the buy box picks the SKU from the browser URL (ProductSummary),
 * so they never split the page cache and never reach a render: every variant
 * link is the product page's edge hit.
 */
const PRODUCT_HTML_IGNORED_QUERY_PARAMS = ["variant", "size", "color"] as const;

/**
 * Discovery files (feeds, sitemaps, robots, llms.txt, the UCP profile) read a
 * fixed set of query parameters, or none, with their defaults. Every other
 * parameter is dropped from their cache key and from the request their
 * render sees, so an unknown parameter can neither split the cache (each
 * variant is the canonical file's entry) nor reach a render. Unlike a page,
 * a discovery file has no functional parameter beyond these.
 */
const DISCOVERY_QUERY_PARAMS: ReadonlyArray<{
  readonly path: RegExp;
  readonly params: Readonly<Record<string, string | null>>;
}> = [
  // Catalogue feeds: the file (`from`, `@scalius/shared/catalog-feed-files`),
  // a smaller read of its first products (`limit`), and the retired `cursor`
  // and `page`, kept so the route can refuse them explicitly.
  { path: /^\/api\/(?:product|facebook)-feed\.xml$/, params: { from: "0", limit: null, cursor: null, page: null } },
  // The product sitemap's later pages carry their signed boundary.
  { path: /^\/sitemap-products\.xml$/, params: { page: "1", after: null } },
  { path: /^\/sitemap-(?:categories|brands|collections)\.xml$/, params: { page: "1" } },
  {
    path: /^\/(?:sitemap\.xml|sitemap\.xsl|sitemap-static\.xml|sitemap-pages\.xml|sitemap-articles\.xml|robots\.txt|llms\.txt|blog\/feed\.xml|\.well-known\/ucp)$/,
    params: {},
  },
];

/**
 * The parameters a discovery file reads, each with its default (`null`: no
 * default), or null when `pathname` is not a discovery file.
 */
export function storefrontDiscoveryQueryParams(
  pathname: string,
): Readonly<Record<string, string | null>> | null {
  return DISCOVERY_QUERY_PARAMS.find((entry) => entry.path.test(pathname))?.params ?? null;
}

/**
 * Whether a parameter never reaches the cache key or the render of the page
 * at `pathname`: an ad-click or campaign parameter anywhere, and any
 * parameter a discovery file does not read.
 */
export function isStorefrontCacheIgnoredParam(pathname: string, key: string): boolean {
  if (isStorefrontTrackingQueryParam(key)) return true;
  const discovery = storefrontDiscoveryQueryParams(pathname);
  return discovery !== null && !Object.hasOwn(discovery, key);
}

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
  const discovery = storefrontDiscoveryQueryParams(pathname);
  if (discovery) {
    return Object.fromEntries(
      Object.entries(discovery).filter((entry): entry is [string, string] => entry[1] !== null),
    );
  }
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

function getIgnoredParams(pathname: string): (key: string) => boolean {
  const productParams = /^\/products\/[^/]+$/.test(pathname)
    ? new Set<string>(PRODUCT_HTML_IGNORED_QUERY_PARAMS)
    : null;
  return (key) => isStorefrontCacheIgnoredParam(pathname, key) || Boolean(productParams?.has(key));
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
