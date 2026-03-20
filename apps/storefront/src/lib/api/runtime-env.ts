/**
 * Runtime environment variable accessors for Cloudflare Worker bindings.
 *
 * All getters delegate to `apiContext.getStore()` (AsyncLocalStorage),
 * which is set per-request by the middleware. This avoids module-level
 * mutable state that would race under concurrent requests.
 *
 * `setRuntimeEnv()` is kept for backward compatibility with the middleware
 * call site but is now a no-op — the middleware passes all vars through
 * `apiContext.run()` instead.
 */

import { apiContext } from "./context";

/**
 * No-op — kept so the middleware call site doesn't need changes.
 * All runtime env access now goes through apiContext.getStore().
 */
export function setRuntimeEnv(_vars: {
    PUBLIC_API_URL?: string;
    PUBLIC_API_BASE_URL?: string;
    CDN_DOMAIN_URL?: string;
    STOREFRONT_URL?: string;
    API_TOKEN?: string;
}): void {
    // Intentionally empty — apiContext.run() in middleware handles this now.
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

/** Returns STOREFRONT_URL from the per-request context. */
export function getRuntimeStorefrontUrl(): string | undefined {
    return apiContext.getStore()?.STOREFRONT_URL;
}

/** Returns API_TOKEN from the per-request context. */
export function getRuntimeApiToken(): string | undefined {
    return apiContext.getStore()?.API_TOKEN;
}
