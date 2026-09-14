/**
 * Platform configuration: the public origins of one deployment.
 *
 * These values are merchant-editable in the dashboard (Settings -> System ->
 * Platform) and stored in the database. They are never Wrangler vars. Each
 * Worker resolves them at request time; the API serves them to the storefront
 * and dashboard through `/api/v1/platform`.
 *
 * This module is dependency-free (no DB, no Env) so every Worker and every
 * test can share the same normalization rules.
 */

import { readiness, readinessIssue, type Readiness } from "./readiness";

export interface PlatformConfig {
  /** Canonical public storefront origin, e.g. https://shop.example.com */
  storefrontUrl: string;
  /** Public API origin browsers call, e.g. https://api.example.com */
  apiUrl: string;
  /** Admin dashboard origin, e.g. https://dashboard.example.com */
  dashboardUrl: string;
  /** Public media base URL (R2 custom domain), e.g. https://cdn.example.com */
  mediaUrl: string;
  /** Optional cookie Domain attribute for customer sessions (cross-subdomain). */
  customerAuthCookieDomain: string;
  /** Extra origins allowed to make credentialed API requests. */
  corsAllowedOrigins: string[];
}

export type PlatformUrlKey = "storefrontUrl" | "apiUrl" | "dashboardUrl" | "mediaUrl";

export const PLATFORM_URL_KEYS: readonly PlatformUrlKey[] = [
  "storefrontUrl",
  "apiUrl",
  "dashboardUrl",
  "mediaUrl",
] as const;

export const EMPTY_PLATFORM_CONFIG: Readonly<PlatformConfig> = Object.freeze({
  storefrontUrl: "",
  apiUrl: "",
  dashboardUrl: "",
  mediaUrl: "",
  customerAuthCookieDomain: "",
  corsAllowedOrigins: [] as string[],
});

/** Host used by service-binding callers; never a real public origin. */
export const INTERNAL_SERVICE_ORIGIN = "https://api.internal";

/** Public API path that returns the platform origins. */
export const PLATFORM_CONFIG_PUBLIC_PATH = "/api/v1/platform";

/** Fixed local development ports used by `pnpm dev`. */
export const LOCAL_DEVELOPMENT_PLATFORM_CONFIG: Readonly<PlatformConfig> = Object.freeze({
  storefrontUrl: "http://localhost:4322",
  apiUrl: "http://localhost:8787",
  dashboardUrl: "http://localhost:4323",
  mediaUrl: "http://localhost:8787/api/v1/media",
  customerAuthCookieDomain: "",
  corsAllowedOrigins: [] as string[],
});

export const PLATFORM_URL_MAX_LENGTH = 2_048;
export const PLATFORM_CORS_ORIGINS_MAX_COUNT = 20;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > PLATFORM_URL_MAX_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  if (!parsed.hostname || parsed.origin === "null") return null;
  // `new URL()` accepts "*" inside a hostname; a wildcard is never an origin.
  if (parsed.hostname.includes("*")) return null;
  const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol === "http:" && !loopback) return null;
  return parsed;
}

export function isLoopbackUrl(value: unknown): boolean {
  const parsed = parseHttpUrl(value);
  return parsed ? LOOPBACK_HOSTS.has(parsed.hostname) : false;
}

export function isInternalServiceUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === INTERNAL_SERVICE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Normalizes a public origin. HTTPS is required; plain HTTP is accepted only
 * for loopback hosts so local development needs no certificate. Paths,
 * queries, fragments, and credentials are rejected because the value is used
 * as an origin, never as a page URL. Returns "" when invalid.
 */
export function normalizePlatformOriginUrl(value: unknown): string {
  const parsed = parseHttpUrl(value);
  if (!parsed) return "";
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
  return parsed.origin;
}

/**
 * Normalizes the public media base. Same scheme rules as origins, but a path
 * is allowed because local development serves media from `/api/v1/media`.
 */
export function normalizeMediaBaseUrl(value: unknown): string {
  const parsed = parseHttpUrl(value);
  if (!parsed) return "";
  if (parsed.search || parsed.hash) return "";
  const pathname = parsed.pathname.replace(/\/+$/g, "");
  return `${parsed.origin}${pathname}`;
}

/** Hostname[:port] of the media base, used for CSP and image host checks. */
export function mediaHostFromUrl(mediaUrl: string): string {
  const parsed = parseHttpUrl(mediaUrl);
  return parsed ? parsed.host : "";
}

/** Cookie Domain attribute: bare lowercase hostname, no scheme, no leading dot. */
export function normalizeCookieDomain(value: unknown): string {
  if (typeof value !== "string") return "";
  const candidate = value.trim().toLowerCase().replace(/^\.+/, "");
  if (!candidate || candidate.length > 253) return "";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(candidate)) {
    return "";
  }
  return candidate;
}

/**
 * Extra credentialed-CORS origins. Exact origins only; the platform origins
 * are always trusted and never need to be listed here.
 */
export function normalizeCorsOrigins(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const origins = new Set<string>();
  for (const entry of raw) {
    const origin = normalizePlatformOriginUrl(entry);
    if (origin) origins.add(origin);
    if (origins.size >= PLATFORM_CORS_ORIGINS_MAX_COUNT) break;
  }
  return [...origins];
}

export function normalizePlatformConfig(raw: unknown): PlatformConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    storefrontUrl: normalizePlatformOriginUrl(source.storefrontUrl),
    apiUrl: normalizePlatformOriginUrl(source.apiUrl),
    dashboardUrl: normalizePlatformOriginUrl(source.dashboardUrl),
    mediaUrl: normalizeMediaBaseUrl(source.mediaUrl),
    customerAuthCookieDomain: normalizeCookieDomain(source.customerAuthCookieDomain),
    corsAllowedOrigins: normalizeCorsOrigins(source.corsAllowedOrigins),
  };
}

/**
 * Local development runs the three Workers on fixed loopback ports. When the
 * current request arrives on a loopback origin, unset platform URLs fall back
 * to those ports so `pnpm dev` needs no configuration. Production origins are
 * never guessed.
 */
export function withLocalDevelopmentDefaults(
  config: PlatformConfig,
  requestOrigin: string | null | undefined,
): PlatformConfig {
  if (!isLoopbackUrl(requestOrigin)) return config;
  return {
    ...config,
    storefrontUrl: config.storefrontUrl || LOCAL_DEVELOPMENT_PLATFORM_CONFIG.storefrontUrl,
    apiUrl: config.apiUrl || LOCAL_DEVELOPMENT_PLATFORM_CONFIG.apiUrl,
    dashboardUrl: config.dashboardUrl || LOCAL_DEVELOPMENT_PLATFORM_CONFIG.dashboardUrl,
    mediaUrl: config.mediaUrl || LOCAL_DEVELOPMENT_PLATFORM_CONFIG.mediaUrl,
  };
}

/** Public request origin, or null for service-binding and malformed URLs. */
export function publicRequestOrigin(requestUrl: string | null | undefined): string | null {
  if (!requestUrl || isInternalServiceUrl(requestUrl)) return null;
  try {
    const parsed = new URL(requestUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.origin === "null" ? null : parsed.origin;
  } catch {
    return null;
  }
}

export function storefrontPurgeUrl(storefrontUrl: string): string {
  const origin = normalizePlatformOriginUrl(storefrontUrl);
  return origin ? `${origin}/api/purge-cache` : "";
}

const PLATFORM_URL_LABELS: Record<PlatformUrlKey, string> = {
  storefrontUrl: "Storefront URL",
  apiUrl: "API URL",
  dashboardUrl: "Dashboard URL",
  mediaUrl: "Media URL",
};

const PLATFORM_URL_ISSUE_CODES: Record<PlatformUrlKey, string> = {
  storefrontUrl: "missing_storefront_url",
  apiUrl: "missing_api_url",
  dashboardUrl: "missing_dashboard_url",
  mediaUrl: "missing_media_url",
};

export const PLATFORM_READINESS_FIX =
  "Set it in the dashboard under Settings -> System -> Platform.";

/**
 * The shared readiness vocabulary plus the typed extra callers need: exactly
 * which platform origins are still unset.
 */
export interface PlatformConfigReadiness extends Readiness {
  missing: PlatformUrlKey[];
}

export function getPlatformConfigReadiness(config: PlatformConfig): PlatformConfigReadiness {
  const missing = PLATFORM_URL_KEYS.filter((key) => !config[key]);
  return {
    ...readiness.from(missing.map((key) => readinessIssue(
      PLATFORM_URL_ISSUE_CODES[key],
      `${PLATFORM_URL_LABELS[key]} is not configured.`,
      PLATFORM_READINESS_FIX,
    ))),
    missing,
  };
}
