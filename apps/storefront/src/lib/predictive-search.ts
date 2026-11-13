// The store's predictive search, as the search palette asks it and as an
// app island asks it (`context.searchSuggestions`): one public `/search`
// request per query, the same URL for both, and one page-lifetime memo of
// answers. The API stores each query's answer (dependency-validated): a
// repeated query, from this or any other buyer, is a hit that costs no
// search budget; only a query no one asked since the catalogue changed is
// charged.
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

/** Products, categories and pages per answer (the palette's list; an island gets at most this many products). */
export const PREDICTIVE_SEARCH_RESULT_LIMIT = STOREFRONT_SEARCH_SUGGESTIONS_MAX;

/**
 * How long the palette waits after a keystroke before it asks: a pause, not
 * every letter. Each predictive query is its own address on the store's
 * search budget (60 a minute per address, shared by every buyer behind one
 * carrier address), and only a cache miss is charged, so a word typed at
 * typing speed must cost one request, not one per letter.
 */
export const PREDICTIVE_SEARCH_MIN_DELAY_MS = 250;
export const PREDICTIVE_SEARCH_MAX_DELAY_MS = 600;

/**
 * The wait before asking, adapted to this buyer's typing: one and a half
 * times their recent gap between keystrokes (the median of the last three),
 * between the two bounds, so a slow typist's next letter still arrives
 * before the request goes. A query that only extends one the store already
 * answered with nothing waits the longest: it is asked once the buyer
 * pauses, never letter by letter (it is still asked, because the store
 * corrects typos only on a whole word: "jak" can find nothing where "jaket"
 * finds jackets).
 */
export function predictiveSearchDelay(keystrokeGapsMs: readonly number[], query: string): number {
  if (extendsEmptyAnswer(query)) return PREDICTIVE_SEARCH_MAX_DELAY_MS;
  const recent = keystrokeGapsMs.slice(-3).filter((gap) => Number.isFinite(gap) && gap > 0).sort((a, b) => a - b);
  if (recent.length === 0) return PREDICTIVE_SEARCH_MIN_DELAY_MS;
  const median = recent[Math.floor(recent.length / 2)]!;
  return Math.round(Math.min(PREDICTIVE_SEARCH_MAX_DELAY_MS, Math.max(PREDICTIVE_SEARCH_MIN_DELAY_MS, median * 1.5)));
}

// Match Shopify's predictive-search pattern: keep successful results for the
// lifetime of the page so revisiting or refining the same query is immediate.
// Full navigations naturally clear this small, bounded memo.
const SEARCH_RESULT_CACHE_LIMIT = 40;
const searchResultCache = new Map<string, PredictiveSearchResponse>();

interface SharedRequest {
  promise: Promise<PredictiveSearchResponse>;
  controller: AbortController;
  waiters: number;
}
const inFlight = new Map<string, SharedRequest>();

const cacheKey = (query: string) => query.toLocaleLowerCase();

/** The answer this page already has for a normalized query. */
export function cachedPredictiveSearch(query: string): PredictiveSearchResponse | undefined {
  return searchResultCache.get(cacheKey(query));
}

const isEmptyAnswer = (results: PredictiveSearchResponse) =>
  results.products.length === 0 && results.categories.length === 0 && results.pages.length === 0;

/** Whether the query only adds letters to one the store answered with nothing on this page. */
function extendsEmptyAnswer(query: string): boolean {
  const key = cacheKey(query);
  for (const [answered, results] of searchResultCache) {
    if (answered !== key && key.startsWith(answered) && isEmptyAnswer(results)) return true;
  }
  return false;
}

function remember(query: string, results: PredictiveSearchResponse): void {
  const key = cacheKey(query);
  if (!searchResultCache.has(key) && searchResultCache.size >= SEARCH_RESULT_CACHE_LIMIT) {
    const oldest = searchResultCache.keys().next().value;
    if (oldest !== undefined) searchResultCache.delete(oldest);
  }
  searchResultCache.set(key, results);
}

/**
 * The store asked this page to slow down (429). Until `retryAfterMs` has
 * passed nothing more is asked: every query answers this at once.
 */
export class PredictiveSearchBusyError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super("Search is busy");
    this.name = "PredictiveSearchBusyError";
  }
}

/** The longest a busy answer holds searching back, whatever the store names. */
const MAX_BUSY_WAIT_MS = 60_000;
const DEFAULT_BUSY_WAIT_MS = 10_000;
let busyUntil = 0;

/** The wait a 429 names: its `Retry-After` header, else the body's `retryAfterSeconds`, bounded. */
async function busyWaitMs(response: Response): Promise<number> {
  const header = Number(response.headers?.get?.("Retry-After"));
  let seconds = Number.isFinite(header) && header > 0 ? header : NaN;
  if (Number.isNaN(seconds)) {
    const body = (await response.json().catch(() => null)) as { error?: { details?: { retryAfterSeconds?: unknown } } } | null;
    const fromBody = Number(body?.error?.details?.retryAfterSeconds);
    seconds = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : NaN;
  }
  return Number.isNaN(seconds) ? DEFAULT_BUSY_WAIT_MS : Math.min(MAX_BUSY_WAIT_MS, Math.ceil(seconds * 1000));
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

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/**
 * The store's answer for a normalized query: from this page's memo, or the
 * request already on its way for it, or one new request. `signal` stops
 * waiting; the request itself is cancelled once no one waits on it. While
 * the store has asked this page to slow down it rejects with
 * `PredictiveSearchBusyError` and asks nothing.
 */
export async function fetchPredictiveSearch(query: string, signal?: AbortSignal): Promise<PredictiveSearchResponse> {
  const cached = cachedPredictiveSearch(query);
  if (cached) return cached;
  if (signal?.aborted) throw abortError(signal);
  const now = Date.now();
  if (busyUntil > now) throw new PredictiveSearchBusyError(busyUntil - now);
  const key = cacheKey(query);
  let shared = inFlight.get(key);
  if (!shared) {
    const controller = new AbortController();
    const promise = (async () => {
      const response = await fetch(predictiveSearchUrl(query), { signal: controller.signal });
      if (response.status === 429) {
        const wait = await busyWaitMs(response);
        busyUntil = Math.max(busyUntil, Date.now() + wait);
        throw new PredictiveSearchBusyError(wait);
      }
      if (!response.ok) throw new Error("Search failed");
      const json = (await response.json()) as { success?: boolean; data?: PredictiveSearchResponse };
      if (!json.success || !json.data || !Array.isArray(json.data.products)) throw new Error("Search response was invalid");
      const data = { ...json.data, categories: json.data.categories ?? [], pages: json.data.pages ?? [] };
      remember(query, data);
      return data;
    })();
    const entry: SharedRequest = { promise, controller, waiters: 0 };
    shared = entry;
    inFlight.set(key, entry);
    void promise.catch(() => undefined).finally(() => {
      if (inFlight.get(key) === entry) inFlight.delete(key);
    });
  }
  const request = shared;
  request.waiters += 1;
  if (!signal) return request.promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(abortError(signal));
      // The last one waiting gave up: the answer is no longer wanted.
      request.waiters -= 1;
      if (request.waiters === 0 && inFlight.get(key) === request) {
        inFlight.delete(key);
        request.controller.abort();
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    request.promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
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
