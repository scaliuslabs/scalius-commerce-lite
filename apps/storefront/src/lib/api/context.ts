// Context injected per-request by Astro middleware.
// Carries Cloudflare Worker runtime bindings (from wrangler.jsonc vars)
// so that SSR code can access them without depending on import.meta.env (build-time only).
export interface ApiContext {
  BACKEND_API?: Fetcher;
  PUBLIC_API_URL?: string;
  PUBLIC_API_BASE_URL?: string;
  CDN_DOMAIN_URL?: string;
  IMAGE_OPTIMIZATION_ENABLED?: boolean;
  IMAGE_CDN_BASE_URL?: string;
  IMAGE_CDN_ALLOWED_HOSTS?: string[];
  IMAGE_CDN_CANONICAL_HOST_ALIASES?: string[];
  STOREFRONT_URL?: string;
  API_TOKEN?: string;
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
