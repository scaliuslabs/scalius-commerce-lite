import { AsyncLocalStorage } from "node:async_hooks";
import type { Fetcher } from "@cloudflare/workers-types";

// Context injected per-request by Astro middleware.
// Carries Cloudflare Worker runtime bindings (from wrangler.jsonc vars)
// so that SSR code can access them without depending on import.meta.env (build-time only).
interface ApiContext {
    BACKEND_API?: Fetcher;
    PUBLIC_API_URL?: string;
    CDN_DOMAIN_URL?: string;
}

export const apiContext = new AsyncLocalStorage<ApiContext>();
