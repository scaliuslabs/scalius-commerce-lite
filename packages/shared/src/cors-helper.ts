interface CorsContext {
  env: Record<string, unknown>;
}

export const getCorsOriginContext = async (c: CorsContext) => {
  const allowedOrigins = await getAllowedCorsOrigins(c);
  return (origin: string): string | null => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return "*";

    const isAllowed = allowedOrigins.some((allowedOrigin) => {
      if (allowedOrigin === "*") return true;
      if (allowedOrigin === origin) return true;

      // Handle wildcard patterns like https://*.scalius.com
      if (allowedOrigin.includes("*")) {
        const pattern = allowedOrigin.replace(/\*/g, ".*");
        return new RegExp(`^${pattern}$`).test(origin);
      }

      return false;
    });

    return isAllowed ? origin : null;
  };
};

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
