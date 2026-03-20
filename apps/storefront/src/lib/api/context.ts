import { AsyncLocalStorage } from "node:async_hooks";
// Fetcher type is defined globally in env.d.ts

// Context injected per-request by Astro middleware.
// Carries Cloudflare Worker runtime bindings (from wrangler.jsonc vars)
// so that SSR code can access them without depending on import.meta.env (build-time only).
export interface ApiContext {
    BACKEND_API?: Fetcher;
    PUBLIC_API_URL?: string;
    PUBLIC_API_BASE_URL?: string;
    CDN_DOMAIN_URL?: string;
    STOREFRONT_URL?: string;
    API_TOKEN?: string;
}

export const apiContext = new AsyncLocalStorage<ApiContext>();
