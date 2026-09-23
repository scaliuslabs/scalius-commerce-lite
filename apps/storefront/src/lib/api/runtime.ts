/**
 * The storefront's per-request runtime.
 *
 * The storefront Worker installs exactly one secret (SCALIUS_SECRET) and no
 * Wrangler vars, so every runtime value is resolved per request and kept in
 * AsyncLocalStorage:
 *
 * - Secrets: API_TOKEN and PURGE_TOKEN are derived from the master secret on
 *   every request (HKDF is cheap; nothing is retained in module globals).
 * - Origins and merchant CSP sources: applied by the middleware from the
 *   request's layout payload (`applyPlatformOrigins`), the same cached read
 *   every page already makes, so there is no separate platform sub-request.
 *   Until then, or when that read fails, no API URL is seeded and API callers
 *   fail closed; the storefront origin stays the request origin so discovery
 *   output stays absolute.
 *
 * SSR code reads these through the getters below instead of import.meta.env
 * (build-time only). Client-side imports get a no-op store, so every getter
 * returns undefined in the browser.
 */
import {
  mediaHostFromUrl,
  normalizeDashboardUrl,
  normalizeMediaBaseUrl,
  normalizePlatformOriginUrl,
  publicRequestOrigin,
} from "@scalius/shared/platform-config";
import {
  deriveRuntimeSecret,
  readMasterSecret,
  RUNTIME_SECRET_PURPOSES,
  type MasterSecretEnvironment,
} from "@scalius/shared/runtime-secrets";
import type { LayoutData } from "./storefront";

/** Bindings and secrets the middleware hands to the request runtime. */
export interface RequestRuntimeEnv extends MasterSecretEnvironment {
  BACKEND_API?: Fetcher;
}

/** Everything one storefront request needs to reach the API and render URLs. */
export interface StorefrontRuntime {
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
  IMAGE_CDN_BASE_URL?: string;
  IMAGE_CDN_CANONICAL_HOST_ALIASES?: string[];
  /** Absolute storefront origin; platform setting or the request origin. */
  STOREFRONT_URL?: string;
  /** Derived service token used to obtain the storefront API JWT. */
  API_TOKEN?: string;
  /** Derived token the API presents when purging the storefront cache. */
  PURGE_TOKEN?: string;
  /** Merchant CSP sources from the layout payload (Settings -> Security). */
  CSP_ALLOWED_DOMAINS?: string;
  /** The request's single layout read, shared by the middleware and pages. */
  layout?: Promise<LayoutData | null>;
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

let _als: AsyncLocalStorageLike<StorefrontRuntime>;

if (import.meta.env.SSR) {
  // Dynamic import avoids Vite bundling node:async_hooks for the client
  const { AsyncLocalStorage } = await import("node:async_hooks");
  _als = new AsyncLocalStorage<StorefrontRuntime>();
} else {
  // Client-side stub — getStore() always returns undefined
  _als = {
    getStore: () => undefined,
    run: <R>(_store: StorefrontRuntime, fn: () => R) => fn(),
  };
}

/** The request-scoped runtime store. Seeded by runWithRequestRuntime(). */
export const requestRuntime: AsyncLocalStorageLike<StorefrontRuntime> = _als;

/** The current request's runtime, or undefined outside a seeded request. */
export function getRuntime(): StorefrontRuntime | undefined {
  return requestRuntime.getStore();
}

/** Returns the public API URL including /api/v1 from the per-request runtime. */
export function getRuntimeApiUrl(): string | undefined {
  return getRuntime()?.PUBLIC_API_URL;
}

/** Returns the public API origin (no /api/v1) from the per-request runtime. */
export function getRuntimeApiBaseUrl(): string | undefined {
  return getRuntime()?.PUBLIC_API_BASE_URL;
}

/** Returns the platform media host[:port] from the per-request runtime. */
export function getRuntimeCdnDomain(): string | undefined {
  return getRuntime()?.CDN_DOMAIN_URL;
}

/** Returns the platform media base URL from the per-request runtime. */
export function getRuntimeMediaUrl(): string | undefined {
  return getRuntime()?.MEDIA_URL;
}

/** Returns the dashboard origin from the per-request runtime. */
export function getRuntimeDashboardUrl(): string | undefined {
  return getRuntime()?.DASHBOARD_URL;
}

export interface RuntimeImageCdnPolicy {
  canonicalCdnUrl?: string;
  canonicalHostAliases?: string[];
}

/** Applies dashboard-loaded media settings to the current SSR request runtime. */
export function setRuntimeImageCdnPolicy(
  policy: RuntimeImageCdnPolicy | null | undefined,
): void {
  const store = getRuntime();
  if (!store || !policy) return;

  store.IMAGE_CDN_BASE_URL = policy.canonicalCdnUrl || undefined;
  store.IMAGE_CDN_CANONICAL_HOST_ALIASES = Array.isArray(
    policy.canonicalHostAliases,
  )
    ? policy.canonicalHostAliases
    : [];
}

export function getRuntimeImageCdnBaseUrl(): string | undefined {
  return getRuntime()?.IMAGE_CDN_BASE_URL;
}

export function getRuntimeImageCdnCanonicalHostAliases(): string[] {
  return getRuntime()?.IMAGE_CDN_CANONICAL_HOST_ALIASES ?? [];
}

/**
 * Returns the absolute storefront origin seeded by the middleware (platform
 * setting, or the request origin when the setting is empty), with any
 * trailing slash stripped. Empty outside the middleware scope.
 */
export function getRuntimeStorefrontUrl(): string {
  const alsUrl = getRuntime()?.STOREFRONT_URL;
  return alsUrl ? alsUrl.replace(/\/$/, "") : "";
}

/** Returns the derived service API token from the per-request runtime. */
export function getRuntimeApiToken(): string | undefined {
  return getRuntime()?.API_TOKEN;
}

/** Returns the BACKEND_API service binding captured for the current request. */
export function getRuntimeBackendApi(): Fetcher | undefined {
  return getRuntime()?.BACKEND_API;
}

/** Returns the request-local in-flight read map used to coalesce reads. */
export function getRuntimeInflightReads():
  | Map<string, Promise<unknown>>
  | undefined {
  return getRuntime()?.inflightReads;
}

function optional(value: string | null | undefined): string | undefined {
  return value || undefined;
}

/**
 * Seeds the current request's platform origins and merchant CSP sources from
 * its layout payload. Malformed values are dropped rather than trusted, and an
 * empty storefront setting keeps the request origin.
 */
export function applyPlatformOrigins(
  layout: Pick<LayoutData, "platform" | "cspAllowedDomains"> | null | undefined,
): void {
  const store = getRuntime();
  if (!store) return;
  // The normalizers accept unknown input, so a malformed payload is dropped.
  const platform: NonNullable<LayoutData["platform"]> = layout?.platform ?? {};
  const apiUrl = optional(normalizePlatformOriginUrl(platform.apiUrl));
  const mediaUrl = optional(normalizeMediaBaseUrl(platform.mediaUrl));
  store.STOREFRONT_URL =
    optional(normalizePlatformOriginUrl(platform.storefrontUrl)) ??
    store.STOREFRONT_URL;
  store.PUBLIC_API_BASE_URL = apiUrl;
  store.PUBLIC_API_URL = apiUrl ? `${apiUrl}/api/v1` : undefined;
  // The dashboard may live below a path prefix on a shared host; keep it.
  store.DASHBOARD_URL = optional(normalizeDashboardUrl(platform.dashboardUrl));
  store.MEDIA_URL = mediaUrl;
  store.CDN_DOMAIN_URL = mediaUrl ? optional(mediaHostFromUrl(mediaUrl)) : undefined;
  const cspAllowedDomains = layout?.cspAllowedDomains;
  store.CSP_ALLOWED_DOMAINS =
    typeof cspAllowedDomains === "string" ? cspAllowedDomains : "";
}

/** Merchant CSP sources seeded from this request's layout payload. */
export function getRuntimeCspAllowedDomains(): string {
  return getRuntime()?.CSP_ALLOWED_DOMAINS ?? "";
}

/**
 * Derives the tokens this deployment uses from the single installed master
 * secret. Returns an empty object when the secret is missing or too short, so
 * every caller fails closed instead of guessing a credential.
 */
export async function deriveRuntimeTokens(
  env: RequestRuntimeEnv | null | undefined,
): Promise<Pick<StorefrontRuntime, "API_TOKEN" | "PURGE_TOKEN">> {
  const master = readMasterSecret(env);
  if (!master) return {};
  const [API_TOKEN, PURGE_TOKEN] = await Promise.all([
    deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.API_TOKEN),
    deriveRuntimeSecret(master, RUNTIME_SECRET_PURPOSES.PURGE_TOKEN),
  ]);
  return { API_TOKEN, PURGE_TOKEN };
}

/**
 * Builds the runtime for one request: derived secrets, with the request
 * origin as the storefront origin until `applyPlatformOrigins` runs.
 */
export async function createRequestRuntime(
  request: Request,
  env: RequestRuntimeEnv | null | undefined,
): Promise<StorefrontRuntime> {
  return {
    BACKEND_API: env?.BACKEND_API,
    STOREFRONT_URL: optional(publicRequestOrigin(request.url)),
    ...(await deriveRuntimeTokens(env)),
    inflightReads: new Map<string, Promise<unknown>>(),
    apiJwt: { token: null, expiresAt: null, refresh: null },
  };
}

/**
 * Seeds the request runtime and runs the rest of the request inside it.
 * Nothing is read from Wrangler vars or import.meta.env, and nothing is
 * retained across requests.
 */
export async function runWithRequestRuntime<R>(
  request: Request,
  env: RequestRuntimeEnv | null | undefined,
  fn: () => R,
): Promise<Awaited<R>> {
  const store = await createRequestRuntime(request, env);
  return await requestRuntime.run(store, fn);
}
