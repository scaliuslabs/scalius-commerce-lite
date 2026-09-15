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

/**
 * Opt-in trusted external identity handoff for the dashboard. Off unless an
 * operator enables it; every field is validated by `normalizeIdentityHandoffConfig`.
 */
export interface IdentityHandoffConfig {
  /** Only true when an issuer and audience are configured. */
  enabled: boolean;
  /** Expected `iss` claim of handoff tokens. */
  issuer: string;
  /** Expected `aud` claim of handoff tokens. */
  audience: string;
  /**
   * Optional HTTPS JWKS URL for asymmetric tokens. Empty means tokens are
   * HS256-signed with the HKDF-derived `IDENTITY_HANDOFF_SECRET`.
   */
  jwksUrl: string;
  /** Hide and refuse password sign-in while the operator manages identity. */
  localLoginDisabled: boolean;
}

export interface PlatformConfig {
  /** Canonical public storefront origin, e.g. https://shop.example.com */
  storefrontUrl: string;
  /** Public API origin browsers call, e.g. https://api.example.com */
  apiUrl: string;
  /**
   * Admin dashboard URL, e.g. https://dashboard.example.com. It may carry a
   * path prefix (https://shop.example.com/dashboard) when the dashboard is
   * served behind a reverse proxy or a Workers route with a path pattern.
   */
  dashboardUrl: string;
  /** Public media base URL (R2 custom domain), e.g. https://cdn.example.com */
  mediaUrl: string;
  /** Optional cookie Domain attribute for customer sessions (cross-subdomain). */
  customerAuthCookieDomain: string;
  /** Extra origins allowed to make credentialed API requests. */
  corsAllowedOrigins: string[];
  /** Require the derived `ADMIN_SETUP_TOKEN` header on `POST /api/v1/setup`. */
  setupTokenRequired: boolean;
  identityHandoff: IdentityHandoffConfig;
}

export type PlatformUrlKey = "storefrontUrl" | "apiUrl" | "dashboardUrl" | "mediaUrl";

export const PLATFORM_URL_KEYS: readonly PlatformUrlKey[] = [
  "storefrontUrl",
  "apiUrl",
  "dashboardUrl",
  "mediaUrl",
] as const;

export const EMPTY_IDENTITY_HANDOFF_CONFIG: Readonly<IdentityHandoffConfig> = Object.freeze({
  enabled: false,
  issuer: "",
  audience: "",
  jwksUrl: "",
  localLoginDisabled: false,
});

export const EMPTY_PLATFORM_CONFIG: Readonly<PlatformConfig> = Object.freeze({
  storefrontUrl: "",
  apiUrl: "",
  dashboardUrl: "",
  mediaUrl: "",
  customerAuthCookieDomain: "",
  corsAllowedOrigins: [] as string[],
  setupTokenRequired: false,
  identityHandoff: EMPTY_IDENTITY_HANDOFF_CONFIG,
});

/** Fresh, mutable copy of the empty configuration for callers that build one. */
export function emptyPlatformConfig(): PlatformConfig {
  return {
    ...EMPTY_PLATFORM_CONFIG,
    corsAllowedOrigins: [],
    identityHandoff: { ...EMPTY_IDENTITY_HANDOFF_CONFIG },
  };
}

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
  setupTokenRequired: false,
  identityHandoff: EMPTY_IDENTITY_HANDOFF_CONFIG,
});

export const PLATFORM_URL_MAX_LENGTH = 2_048;
export const PLATFORM_CORS_ORIGINS_MAX_COUNT = 20;
export const DASHBOARD_BASE_PATH_MAX_SEGMENTS = 4;
export const IDENTITY_HANDOFF_CLAIM_MAX_LENGTH = 512;
/** Lowercase URL-safe segments only, so a prefix can never collide with a CMS slug by case. */
const DASHBOARD_BASE_PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
 * Normalizes the dashboard URL: an origin plus an optional lowercase path
 * prefix (at most four segments) and no trailing slash, query, or fragment.
 * The prefix is the runtime base path of the dashboard Worker. Returns ""
 * when invalid.
 */
export function normalizeDashboardUrl(value: unknown): string {
  const parsed = parseHttpUrl(value);
  if (!parsed) return "";
  if (parsed.search || parsed.hash) return "";
  const basePath = normalizeDashboardBasePath(parsed.pathname);
  if (basePath === null) return "";
  return `${parsed.origin}${basePath}`;
}

/**
 * Normalizes a dashboard path prefix to "" (root) or "/a/b". Returns null
 * when a segment is not lowercase URL-safe or the prefix is too deep.
 */
export function normalizeDashboardBasePath(pathname: unknown): string | null {
  if (typeof pathname !== "string") return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  if (segments.length > DASHBOARD_BASE_PATH_MAX_SEGMENTS) return null;
  if (!segments.every((segment) => DASHBOARD_BASE_PATH_SEGMENT.test(segment))) return null;
  return `/${segments.join("/")}`;
}

/** The runtime base path ("" or "/prefix") of a normalized dashboard URL. */
export function dashboardBasePathFromUrl(dashboardUrl: unknown): string {
  const parsed = parseHttpUrl(dashboardUrl);
  if (!parsed) return "";
  return normalizeDashboardBasePath(parsed.pathname) ?? "";
}

/**
 * The first path segment of the dashboard URL, or null when the dashboard is
 * served at a host root. The storefront treats it as a reserved route so a CMS
 * page can never shadow the dashboard on a shared host.
 *
 * The reservation is only real when the two share an origin: a dashboard on its
 * own hostname takes nothing away from the storefront's URL space, so passing
 * `storefrontUrl` keeps a legitimate page slug usable there. It releases the
 * slug only on proof — when both origins parse and differ. An unknown or
 * unreadable storefront origin keeps the reservation, because letting a CMS
 * page shadow the dashboard is the worse failure.
 */
export function dashboardReservedSegment(
  dashboardUrl: unknown,
  storefrontUrl?: unknown,
): string | null {
  const basePath = dashboardBasePathFromUrl(dashboardUrl);
  if (!basePath) return null;
  if (provenDifferentOrigin(dashboardUrl, storefrontUrl)) return null;
  return basePath.split("/")[1] ?? null;
}

function provenDifferentOrigin(left: unknown, right: unknown): boolean {
  const first = parseHttpUrl(left);
  const second = parseHttpUrl(right);
  return first !== null && second !== null && first.origin !== second.origin;
}

/** Prefixes a root-relative dashboard path with the runtime base path exactly once. */
export function prefixDashboardBasePath(basePath: string, path: string): string {
  if (!basePath) return path;
  if (!path.startsWith("/")) return `${basePath}/${path}`;
  if (path === basePath || path.startsWith(`${basePath}/`)) return path;
  return `${basePath}${path}`;
}

/**
 * Removes the runtime base path from an incoming pathname, or returns null
 * when the request is outside the dashboard prefix.
 */
export function stripDashboardBasePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return null;
}

/**
 * Joins a platform URL that may carry a path prefix with a route path.
 * `new URL(path, base)` would drop the prefix, so every dashboard link goes
 * through here. Returns "" when the base is empty.
 */
export function joinPlatformUrl(base: string, path: string): string {
  const trimmedBase = base.trim().replace(/\/+$/g, "");
  if (!trimmedBase) return "";
  if (!path) return trimmedBase;
  return `${trimmedBase}${path.startsWith("/") ? path : `/${path}`}`;
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

function normalizeClaimValue(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > IDENTITY_HANDOFF_CLAIM_MAX_LENGTH) return "";
  // Control characters and whitespace never belong in an issuer or audience.
  if (/[\s\p{Cc}]/u.test(trimmed)) return "";
  return trimmed;
}

/** Optional JWKS URL: HTTPS (or loopback HTTP), path allowed, no credentials or fragment. */
export function normalizeJwksUrl(value: unknown): string {
  const parsed = parseHttpUrl(value);
  if (!parsed || parsed.hash) return "";
  return parsed.href;
}

/**
 * Fail-closed normalization: the handoff is enabled only with an issuer and
 * an audience, and local sign-in can be disabled only while it is enabled.
 */
export function normalizeIdentityHandoffConfig(raw: unknown): IdentityHandoffConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const issuer = normalizeClaimValue(source.issuer);
  const audience = normalizeClaimValue(source.audience);
  const enabled = source.enabled === true && Boolean(issuer) && Boolean(audience);
  return {
    enabled,
    issuer,
    audience,
    jwksUrl: normalizeJwksUrl(source.jwksUrl),
    localLoginDisabled: enabled && source.localLoginDisabled === true,
  };
}

export function normalizePlatformConfig(raw: unknown): PlatformConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    storefrontUrl: normalizePlatformOriginUrl(source.storefrontUrl),
    apiUrl: normalizePlatformOriginUrl(source.apiUrl),
    dashboardUrl: normalizeDashboardUrl(source.dashboardUrl),
    mediaUrl: normalizeMediaBaseUrl(source.mediaUrl),
    customerAuthCookieDomain: normalizeCookieDomain(source.customerAuthCookieDomain),
    corsAllowedOrigins: normalizeCorsOrigins(source.corsAllowedOrigins),
    setupTokenRequired: source.setupTokenRequired === true,
    identityHandoff: normalizeIdentityHandoffConfig(source.identityHandoff),
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
