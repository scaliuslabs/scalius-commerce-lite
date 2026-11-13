import type {
  CacheFrontierEntry,
  StorefrontBatchPartCache,
} from "@scalius/shared/cache-frontier";

/**
 * The dependency proof of one storefront render (CACHE-DESIGN §6.7): every
 * API part the render read composes into the page entry, s0 = min, deps =
 * union, validUntil and the soft-order bound = min. A read that carried no
 * proof (a lone read, a failed part, a part from an API not in strict mode)
 * makes the whole render unprovable, and such a page is never stored under a
 * dependency-validated key.
 *
 * The gateway opens the collector before the render and reads it after the
 * body has streamed to the end, so reads made by components while the page
 * streams count too.
 */
export interface PageDependencies {
  apiVersion: string | null;
  s0: number | null;
  readonly deps: Set<string>;
  validUntil: number | null;
  /** Epoch ms the soft (recommendation, popularity) order may be served until. */
  softUntil: number | null;
  renderedAt: number | null;
  unproven: boolean;
  /**
   * The render drew a fallback for a read that failed (a 5xx, a throttle, a
   * timeout) or an app component that could not render: it is this buyer's
   * page only, never stored and never handed to a request that joined it.
   */
  degraded: boolean;
  /**
   * The reads that answered 404 (a lookup that found nothing): how many the
   * API served from its own bounded not-found cache (a hit, so its per-minute
   * budget admitted it) and how many it rendered. A 404 page is stored only
   * when every one of them was such a hit (`notFoundReadsAdmitted`).
   */
  notFoundReads: { admitted: number; unadmitted: number };
}

/** Most dependency hashes one stored page carries (about 13 bytes each in a header). */
export const MAX_PAGE_DEPENDENCIES = 1_024;

export function createPageDependencies(): PageDependencies {
  return { apiVersion: null, s0: null, deps: new Set(), validUntil: null, softUntil: null, renderedAt: null, unproven: false, degraded: false, notFoundReads: { admitted: 0, unadmitted: 0 } };
}

const minOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

/** Adds one batch part's proof; a part without one makes the render unprovable. */
export function recordPagePart(
  target: PageDependencies | null | undefined,
  cache: StorefrontBatchPartCache | null | undefined,
  /** The part's HTTP status: a 404 is counted for `notFoundReadsAdmitted`. */
  httpStatus?: number,
): void {
  if (!target) return;
  if (httpStatus === 404) {
    if (cache?.status === "hit") target.notFoundReads.admitted += 1;
    else target.notFoundReads.unadmitted += 1;
  }
  if (!cache || typeof cache.apiVersion !== "string" || !cache.apiVersion.trim() || (target.apiVersion !== null && target.apiVersion !== cache.apiVersion)) {
    target.unproven = true;
    return;
  }
  target.apiVersion = cache.apiVersion;
  target.s0 = minOf(target.s0, cache.s0);
  for (const hash of cache.deps) target.deps.add(hash);
  target.validUntil = minOf(target.validUntil, cache.validUntil);
  target.renderedAt = minOf(target.renderedAt, cache.renderedAt);
  if (cache.softMaxAgeSeconds !== null) {
    target.softUntil = minOf(target.softUntil, cache.renderedAt + cache.softMaxAgeSeconds * 1000);
  }
}

/**
 * Whether the render's "not found" may be stored: it read at least one 404,
 * and every 404 it read came from the API's not-found cache, which stores at
 * most its per-minute budget of them. A random address asked once is
 * rendered by the API and never stored here, so random addresses cannot fill
 * the storefront's cache either.
 */
export function notFoundReadsAdmitted(dependencies: PageDependencies): boolean {
  return dependencies.notFoundReads.admitted > 0 && dependencies.notFoundReads.unadmitted === 0;
}

export function markPageUnproven(target: PageDependencies | null | undefined): void {
  if (target) target.unproven = true;
}

/**
 * The render fell back on a failed read. Set from wherever it happens, while
 * the body streams too (when the response headers are long sent, so
 * `markRenderUncacheable` could no longer reach them); the page cache reads
 * it once the body has ended and shares the render with no one.
 */
export function markRenderDegraded(target: PageDependencies | null | undefined): void {
  if (!target) return;
  target.unproven = true;
  target.degraded = true;
}

/** The page entry the hit rule validates, or null when the render proves nothing. */
export function pageEntryFromDependencies(dependencies: PageDependencies): CacheFrontierEntry | null {
  if (!dependencies.apiVersion || dependencies.unproven || dependencies.s0 === null || dependencies.renderedAt === null) return null;
  if (dependencies.deps.size > MAX_PAGE_DEPENDENCIES) return null;
  return {
    apiVersion: dependencies.apiVersion,
    s0: dependencies.s0,
    depHashes: [...dependencies.deps],
    validUntil: dependencies.validUntil,
    softMaxAgeSeconds: dependencies.softUntil === null
      ? null
      : Math.max(0, (dependencies.softUntil - dependencies.renderedAt) / 1000),
    renderedAt: dependencies.renderedAt,
  };
}

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

let scope: AsyncLocalStorageLike<PageDependencies>;
if (import.meta.env.SSR) {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  scope = new AsyncLocalStorage<PageDependencies>();
} else {
  scope = { getStore: () => undefined, run: <R>(_store: PageDependencies, fn: () => R) => fn() };
}

/** Runs a render with a collector the request runtime picks up (`createRequestRuntime`). */
export function collectPageDependencies<R>(target: PageDependencies, fn: () => R): R {
  return scope.run(target, fn);
}

/** The collector of the render in progress, if the gateway opened one. */
export function currentPageDependencies(): PageDependencies | undefined {
  return scope.getStore();
}
