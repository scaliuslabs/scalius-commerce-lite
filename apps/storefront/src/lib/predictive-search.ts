// The store's predictive search, as the search palette asks it and as an
// app island asks it (`context.searchSuggestions`): one public, cached
// `/search` request per query, the same URL for both, so they share the
// browser's and the edge's cache, and one page-lifetime memo of answers.
import type { StorefrontImage, StorefrontSearchSuggestion } from "@scalius/shared/plugins/storefront-protocol";
import { STOREFRONT_SEARCH_SUGGESTIONS_MAX } from "@scalius/shared/plugins/storefront-protocol";
import { priceLineClaim, toMinor } from "@scalius/shared/money";
import { isSearchableQuery } from "@scalius/shared/search-query";
import { browserApiUrl } from "@/lib/api/browser-url";
import { pageLocale, searchProvider } from "@/lib/app-services";
import { formatMinorMoney, getCurrencyCode, getDecimalPlaces } from "@/lib/currency";
import { currentPresence, pagePath } from "@/lib/presence-url";
import { getProductImageUrl, hasProductImage } from "@/lib/product-media";
import { normalizeSearchQuery } from "@/lib/search-query";

export interface PredictiveSearchItem {
  id: string;
  name?: string;
  title?: string;
  slug: string;
  price?: number;
  imageUrl?: string | null;
  imageAlt?: string | null;
  discountedPrice?: number;
  priceVaries?: boolean;
  availableForSale?: boolean;
}

export interface PredictiveSearchResponse {
  products: PredictiveSearchItem[];
  categories: PredictiveSearchItem[];
  pages: PredictiveSearchItem[];
  /** Set when the typed query matched nothing and these results are for this corrected query. */
  correctedQuery?: string | null;
}

/** How long the palette waits after a keystroke before it asks. */
export const PREDICTIVE_SEARCH_DEBOUNCE_MS = 150;
/** Products, categories and pages per answer (the palette's list; an island gets at most this many products). */
export const PREDICTIVE_SEARCH_RESULT_LIMIT = STOREFRONT_SEARCH_SUGGESTIONS_MAX;

// Match Shopify's predictive-search pattern: keep successful results for the
// lifetime of the page so revisiting or refining the same query is immediate.
// Full navigations naturally clear this small, bounded memo.
const SEARCH_RESULT_CACHE_LIMIT = 40;
const searchResultCache = new Map<string, PredictiveSearchResponse>();
const inFlight = new Map<string, Promise<PredictiveSearchResponse>>();

const cacheKey = (query: string) => query.toLocaleLowerCase();

/** The answer this page already has for a normalized query. */
export function cachedPredictiveSearch(query: string): PredictiveSearchResponse | undefined {
  return searchResultCache.get(cacheKey(query));
}

function remember(query: string, results: PredictiveSearchResponse): void {
  const key = cacheKey(query);
  if (!searchResultCache.has(key) && searchResultCache.size >= SEARCH_RESULT_CACHE_LIMIT) {
    const oldest = searchResultCache.keys().next().value;
    if (oldest !== undefined) searchResultCache.delete(oldest);
  }
  searchResultCache.set(key, results);
}

/** The one request URL for a normalized query (the palette's and every island's). */
export function predictiveSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: query,
    limit: String(PREDICTIVE_SEARCH_RESULT_LIMIT),
    searchCategories: "true",
    searchPages: "true",
  });
  // A presence page's market prices the hits (MARKETS-DESIGN D5).
  const presence = currentPresence();
  if (presence) params.set("presence", presence);
  // The store's search app ranks the hits; the API falls back to built-in
  // search by itself, so nothing changes without one.
  const provider = searchProvider();
  if (provider) {
    params.set("provider", provider);
    params.set("locale", pageLocale());
  }
  return browserApiUrl(`/search?${params}`);
}

/**
 * The store's answer for a normalized query: from this page's memo, or the
 * request already on its way for it, or one new request. `signal` stops
 * waiting; a shared request runs on for the others waiting on it.
 */
export async function fetchPredictiveSearch(query: string, signal?: AbortSignal): Promise<PredictiveSearchResponse> {
  const cached = cachedPredictiveSearch(query);
  if (cached) return cached;
  const key = cacheKey(query);
  let request = inFlight.get(key);
  if (!request) {
    request = (async () => {
      const response = await fetch(predictiveSearchUrl(query));
      if (!response.ok) throw new Error("Search failed");
      const json = (await response.json()) as { success?: boolean; data?: PredictiveSearchResponse };
      if (!json.success || !json.data || !Array.isArray(json.data.products)) throw new Error("Search response was invalid");
      const data = { ...json.data, categories: json.data.categories ?? [], pages: json.data.pages ?? [] };
      remember(query, data);
      return data;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, request);
  }
  if (!signal) return request;
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const SUGGESTION_IMAGE_WIDTH = 160;

function money(amount: number): StorefrontSearchSuggestion["price"] {
  const currency = getCurrencyCode();
  const minor = { amountMinor: toMinor(Math.max(0, amount), getDecimalPlaces(currency)), currency };
  return { ...minor, formatted: formatMinorMoney(minor) };
}

function suggestionImage(item: PredictiveSearchItem, title: string): StorefrontImage | null {
  if (!hasProductImage(item.imageUrl)) return null;
  return { url: getProductImageUrl(item.imageUrl, SUGGESTION_IMAGE_WIDTH), srcset: null, width: null, height: null, alt: item.imageAlt || title };
}

/** One product hit as an island gets it: typed, in the page's currency and market, with its page's URL. */
export function searchSuggestionOf(item: PredictiveSearchItem): StorefrontSearchSuggestion {
  const title = item.name ?? item.title ?? "";
  const regular = typeof item.price === "number" ? item.price : 0;
  const paid = typeof item.discountedPrice === "number" ? item.discountedPrice : regular;
  return {
    productId: item.id,
    title,
    url: pagePath(`/products/${item.slug}`),
    image: suggestionImage(item, title),
    price: money(paid),
    compareAt: (() => {
      const { compareAt } = priceLineClaim({ current: paid, regular, from: item.priceVaries === true });
      return compareAt === null ? null : money(compareAt);
    })(),
    priceVaries: item.priceVaries === true,
    available: item.availableForSale !== false,
  };
}

/**
 * `context.searchSuggestions`: the store's product suggestions for what a
 * buyer typed, at most `limit` (1 to STOREFRONT_SEARCH_SUGGESTIONS_MAX,
 * default 5). Too short to search (one Latin letter) answers `[]` and asks
 * nothing, as the palette does; a failed search rejects.
 */
export async function searchSuggestions(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<StorefrontSearchSuggestion[]> {
  const normalized = normalizeSearchQuery(typeof query === "string" ? query : "");
  if (!isSearchableQuery(normalized)) return [];
  const asked = Number.isFinite(options.limit) ? Math.trunc(options.limit!) : 5;
  const limit = Math.min(STOREFRONT_SEARCH_SUGGESTIONS_MAX, Math.max(1, asked));
  const results = await fetchPredictiveSearch(normalized, options.signal);
  return results.products.slice(0, limit).map(searchSuggestionOf);
}
