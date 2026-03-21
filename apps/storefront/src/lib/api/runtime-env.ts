/**
 * Runtime environment variable accessors for Cloudflare Worker bindings.
 *
 * All getters delegate to `apiContext.getStore()` (AsyncLocalStorage),
 * which is set per-request by the middleware. This avoids module-level
 * mutable state that would race under concurrent requests.
 *
 * For STOREFRONT_URL specifically, a fallback chain is provided:
 * ALS -> cloudflare:workers env -> import.meta.env -> empty string.
 * This supports sitemap routes that may run outside the ALS middleware.
 */

import { apiContext } from "./context";

// Cache the cloudflare:workers env for the STOREFRONT_URL fallback.
// This is a static binding (same for all requests in a Worker), so safe
// to read at module init. Null on non-Cloudflare environments.
let _cfEnv: Record<string, string | undefined> | null = null;
if (import.meta.env.SSR) {
    try {
        const { env } = await import("cloudflare:workers");
        _cfEnv = env as unknown as Record<string, string | undefined>;
    } catch {
        // Not running in Cloudflare Workers (e.g., Vite dev server)
    }
}

/** Returns PUBLIC_API_URL from the per-request context. */
export function getRuntimeApiUrl(): string | undefined {
    return apiContext.getStore()?.PUBLIC_API_URL;
}

/** Returns PUBLIC_API_BASE_URL from the per-request context. */
export function getRuntimeApiBaseUrl(): string | undefined {
    return apiContext.getStore()?.PUBLIC_API_BASE_URL;
}

/** Returns CDN_DOMAIN_URL from the per-request context. */
export function getRuntimeCdnDomain(): string | undefined {
    return apiContext.getStore()?.CDN_DOMAIN_URL;
}

/**
 * Returns STOREFRONT_URL with a full fallback chain.
 * 1. ALS per-request context (set by middleware)
 * 2. cloudflare:workers module env (static binding, safe for concurrent reads)
 * 3. import.meta.env build-time var
 * 4. empty string
 *
 * Always returns a string with trailing slash stripped.
 */
export function getRuntimeStorefrontUrl(): string {
    // 1. ALS context (preferred — set per-request by middleware)
    const alsUrl = apiContext.getStore()?.STOREFRONT_URL;
    if (alsUrl) return alsUrl.replace(/\/$/, '');

    // 2. Cloudflare Workers module env (static binding)
    const workerUrl = _cfEnv?.STOREFRONT_URL;
    if (workerUrl) return workerUrl.replace(/\/$/, '');

    // 3. Build-time env var
    const buildUrl = import.meta.env.STOREFRONT_URL;
    if (buildUrl) return String(buildUrl).replace(/\/$/, '');

    return '';
}

/** Returns API_TOKEN from the per-request context. */
export function getRuntimeApiToken(): string | undefined {
    return apiContext.getStore()?.API_TOKEN;
}
