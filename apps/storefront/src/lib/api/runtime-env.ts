/**
 * Runtime configuration accessors for SSR code.
 *
 * All getters delegate to `apiContext.getStore()` (AsyncLocalStorage), which
 * is seeded per request by the middleware from the master secret and the
 * API's /api/v1/platform response. There is no module-level state and no
 * Wrangler var or import.meta.env fallback: when a value is absent here it is
 * absent for the request, and callers fail closed.
 */

import { apiContext } from "./context";

/** Returns the public API URL including /api/v1 from the per-request context. */
export function getRuntimeApiUrl(): string | undefined {
  return apiContext.getStore()?.PUBLIC_API_URL;
}

/** Returns the public API origin (no /api/v1) from the per-request context. */
export function getRuntimeApiBaseUrl(): string | undefined {
  return apiContext.getStore()?.PUBLIC_API_BASE_URL;
}

/** Returns the platform media host[:port] from the per-request context. */
export function getRuntimeCdnDomain(): string | undefined {
  return apiContext.getStore()?.CDN_DOMAIN_URL;
}

/** Returns the platform media base URL from the per-request context. */
export function getRuntimeMediaUrl(): string | undefined {
  return apiContext.getStore()?.MEDIA_URL;
}

/** Returns the dashboard origin from the per-request context. */
export function getRuntimeDashboardUrl(): string | undefined {
  return apiContext.getStore()?.DASHBOARD_URL;
}

export interface RuntimeImageCdnPolicy {
  enabled?: boolean;
  canonicalCdnUrl?: string;
  allowedImageHosts?: string[];
  canonicalHostAliases?: string[];
}

/** Applies dashboard-loaded media settings to the current SSR request context. */
export function setRuntimeImageCdnPolicy(
  policy: RuntimeImageCdnPolicy | null | undefined,
): void {
  const store = apiContext.getStore();
  if (!store || !policy) return;

  store.IMAGE_OPTIMIZATION_ENABLED = policy.enabled !== false;
  store.IMAGE_CDN_BASE_URL = policy.canonicalCdnUrl || undefined;
  store.IMAGE_CDN_ALLOWED_HOSTS = Array.isArray(policy.allowedImageHosts)
    ? policy.allowedImageHosts
    : [];
  store.IMAGE_CDN_CANONICAL_HOST_ALIASES = Array.isArray(
    policy.canonicalHostAliases,
  )
    ? policy.canonicalHostAliases
    : [];
}

export function getRuntimeImageCdnBaseUrl(): string | undefined {
  return apiContext.getStore()?.IMAGE_CDN_BASE_URL;
}

export function getRuntimeImageOptimizationEnabled(): boolean | undefined {
  return apiContext.getStore()?.IMAGE_OPTIMIZATION_ENABLED;
}

export function getRuntimeImageCdnAllowedHosts(): string[] {
  return apiContext.getStore()?.IMAGE_CDN_ALLOWED_HOSTS ?? [];
}

export function getRuntimeImageCdnCanonicalHostAliases(): string[] {
  return apiContext.getStore()?.IMAGE_CDN_CANONICAL_HOST_ALIASES ?? [];
}

/**
 * Returns the absolute storefront origin seeded by the middleware (platform
 * setting, or the request origin when the setting is empty), with any
 * trailing slash stripped. Empty outside the middleware scope.
 */
export function getRuntimeStorefrontUrl(): string {
  const alsUrl = apiContext.getStore()?.STOREFRONT_URL;
  return alsUrl ? alsUrl.replace(/\/$/, "") : "";
}

/** Returns the derived service API token from the per-request context. */
export function getRuntimeApiToken(): string | undefined {
  return apiContext.getStore()?.API_TOKEN;
}

/** Returns the BACKEND_API service binding captured for the current request. */
export function getRuntimeBackendApi(): Fetcher | undefined {
  return apiContext.getStore()?.BACKEND_API;
}
