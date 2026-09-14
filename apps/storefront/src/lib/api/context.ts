// Context injected per-request by Astro middleware.
//
// The storefront Worker installs exactly one secret (SCALIUS_SECRET) and no
// Wrangler vars. Every value below is resolved at request time: derived
// secrets come from the master secret, public origins come from the API's
// /api/v1/platform endpoint, and the storefront's own origin is the fallback
// for STOREFRONT_URL. SSR code reads these through lib/api/runtime-env.ts
// instead of depending on import.meta.env (build-time only).
export interface ApiContext {
  BACKEND_API?: Fetcher;
  /** Public API URL including the /api/v1 prefix. */
  PUBLIC_API_URL?: string;
  /** Public API origin without the /api/v1 prefix. */
  PUBLIC_API_BASE_URL?: string;
  /** Host[:port] of the platform media base, for CSP and image host checks. */
  CDN_DOMAIN_URL?: string;
  /** Public media base URL from platform settings (R2 custom domain). */
  MEDIA_URL?: string;
  /** Admin dashboard origin. */
  DASHBOARD_URL?: string;
  IMAGE_OPTIMIZATION_ENABLED?: boolean;
  IMAGE_CDN_BASE_URL?: string;
  IMAGE_CDN_ALLOWED_HOSTS?: string[];
  IMAGE_CDN_CANONICAL_HOST_ALIASES?: string[];
  /** Absolute storefront origin; platform setting or the request origin. */
  STOREFRONT_URL?: string;
  /** Derived service token used to obtain the storefront API JWT. */
  API_TOKEN?: string;
  /** Derived token the API presents when purging the storefront cache. */
  PURGE_TOKEN?: string;
  /** Request-local read coalescing. Never share in-flight I/O across requests. */
  inflightReads?: Map<string, Promise<unknown>>;
  /** Request-local API credential derived from the current request bindings. */
  apiJwt?: {
    token: string | null;
    expiresAt: number | null;
    refresh: Promise<string | null> | null;
  };
}

// AsyncLocalStorage is only available server-side (Cloudflare Workers / Node).
// Client-side imports of this module get a no-op stub that returns undefined.
interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, fn: () => R): R;
}

let _als: AsyncLocalStorageLike<ApiContext>;

if (import.meta.env.SSR) {
  // Dynamic import avoids Vite bundling node:async_hooks for the client
  const { AsyncLocalStorage } = await import("node:async_hooks");
  _als = new AsyncLocalStorage<ApiContext>();
} else {
  // Client-side stub — getStore() always returns undefined
  _als = {
    getStore: () => undefined,
    run: <R>(_store: ApiContext, fn: () => R) => fn(),
  };
}

export const apiContext: AsyncLocalStorageLike<ApiContext> = _als;
