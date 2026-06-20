interface CorsContext {
  env: Record<string, unknown>;
}

export const getCorsOriginContext = async (c: CorsContext) => {
  const allowedOrigins = await getAllowedCorsOrigins(c);
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
    return new URL(origin.trim()).origin;
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
  if (allowed === "*") return true;

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

async function getAllowedCorsOrigins(c: CorsContext): Promise<string[]> {
  // Try to get from KV, fallback to env
  let cspAllowed = (c.env?.CSP_ALLOWED as string) || "";
  try {
    if (c.env?.CACHE) {
      const cache = c.env.CACHE as { get(key: string): Promise<string | null> };
      const cached = await cache.get("security:csp_allowed_domains");
      if (cached !== null) {
        cspAllowed = cached;
      }
    }
  } catch (e: unknown) {
    console.error("Failed to read CSP_ALLOWED from KV Cache", e);
  }

  const cdnDomain = c.env?.CDN_DOMAIN_URL as string | undefined;

  // Auto-allow all platform URLs from env
  const origins = [
    // Allow all localhost ports in development
    "http://localhost:*",
    "http://127.0.0.1:*",
  ];

  // Add platform URLs from env (API, admin, storefront, CDN)
  const envKeys = ["PUBLIC_API_BASE_URL", "BETTER_AUTH_URL", "STOREFRONT_URL"];
  for (const key of envKeys) {
    const val = ((c.env?.[key] as string) || "").trim();
    if (val) origins.push(val);
  }

  if (cdnDomain) {
    origins.push(`https://${cdnDomain}`, `https://*.${cdnDomain}`);
  }

  if (cspAllowed.trim()) {
    const customOrigins = cspAllowed
      .split(",")
      .map((domain: string) => domain.trim())
      .filter((domain: string) => domain.length > 0)
      .flatMap((domain: string) => {
        // Remove https:// if present to normalize
        const cleanDomain = domain.replace(/^https?:\/\//, "");

        // If it's already a wildcard, just add https
        if (cleanDomain.startsWith("*.")) {
          return [`https://${cleanDomain}`];
        }

        // For regular domains, add both exact and wildcard
        return [`https://${cleanDomain}`, `https://*.${cleanDomain}`];
      });

    origins.push(...customOrigins);
  }
  return origins;
}
