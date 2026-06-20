interface CorsContext {
  env: Record<string, unknown>;
}

const FIRST_PARTY_ORIGIN_ENV_KEYS = [
  "PUBLIC_API_BASE_URL",
  "BETTER_AUTH_URL",
  "STOREFRONT_URL",
] as const;

const EXTRA_CREDENTIAL_ORIGIN_ENV_KEYS = [
  "CREDENTIAL_CORS_ALLOWED_ORIGINS",
  "CORS_ALLOWED_ORIGINS",
] as const;

const LOOPBACK_DEVELOPMENT_ORIGINS = [
  "http://localhost:*",
  "http://127.0.0.1:*",
  "http://[::1]:*",
] as const;

export const getCorsOriginContext = async (c: CorsContext) => {
  const allowedOrigins = getAllowedCorsOrigins(c);
  return (origin: string): string | null => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return "*";

    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin) return null;

    const isAllowed = allowedOrigins.some((allowedOrigin) =>
      isAllowedOriginMatch(allowedOrigin, normalizedOrigin),
    );

    return isAllowed ? normalizedOrigin : null;
  };
};

function normalizeOrigin(origin: string): string | null {
  try {
    const url = new URL(origin.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllowedOriginMatch(allowedOrigin: string, origin: string): boolean {
  const allowed = allowedOrigin.trim();
  if (!allowed) return false;

  if (!allowed.includes("*")) {
    return normalizeOrigin(allowed) === origin;
  }

  const match = /^(https?:\/\/)(.+)$/i.exec(allowed);
  if (!match) return false;

  const scheme = match[1]!;
  const hostAndPort = match[2]!;
  const portWildcard = hostAndPort.endsWith(":*");
  const hostPattern = portWildcard ? hostAndPort.slice(0, -2) : hostAndPort;

  if (hostPattern.startsWith("*.")) {
    const baseHost = hostPattern.slice(2);
    if (!baseHost || baseHost.includes("*")) return false;

    const subdomainPattern = `[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`;
    const portPattern = portWildcard ? `(?::\\d{1,5})` : "";
    const pattern = `^${escapeRegExp(scheme)}(?:${subdomainPattern}\\.)+${escapeRegExp(baseHost)}${portPattern}$`;
    return new RegExp(pattern, "i").test(origin);
  }

  if (portWildcard && !hostPattern.includes("*")) {
    const pattern = `^${escapeRegExp(scheme)}${escapeRegExp(hostPattern)}:\\d{1,5}$`;
    return new RegExp(pattern, "i").test(origin);
  }

  return false;
}

function isLoopbackOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function getAllowedCorsOrigins(c: CorsContext): string[] {
  const origins: string[] = [];
  let isLoopbackRuntime = false;

  // Add exact first-party platform origins from env.
  for (const key of FIRST_PARTY_ORIGIN_ENV_KEYS) {
    const val = ((c.env?.[key] as string) || "").trim();
    const origin = normalizeOrigin(val);
    if (!origin) continue;
    origins.push(origin);
    isLoopbackRuntime ||= isLoopbackOrigin(origin);
  }

  if (isLoopbackRuntime) {
    origins.push(...LOOPBACK_DEVELOPMENT_ORIGINS);
  }

  // Separate explicit credentialed-CORS origins from merchant CSP domains.
  // Values must be URL origins; CSP hostnames/wildcards are intentionally ignored.
  for (const key of EXTRA_CREDENTIAL_ORIGIN_ENV_KEYS) {
    const raw = ((c.env?.[key] as string) || "").trim();
    if (!raw) continue;
    const extraOrigins = raw
      .split(",")
      .filter((value: string) => !value.includes("*"))
      .map((value: string) => normalizeOrigin(value))
      .filter((value: string | null): value is string => Boolean(value));

    origins.push(...extraOrigins);
  }

  return origins;
}
