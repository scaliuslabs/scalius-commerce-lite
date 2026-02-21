export const getCorsOriginContext = async (c: any) => {
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

async function getAllowedCorsOrigins(c: any): Promise<string[]> {
  // Try to get from KV, fallback to env
  let cspAllowed = c.env?.CSP_ALLOWED || "";
  try {
    if (c.env?.CACHE) {
      const cached = await c.env.CACHE.get("security:csp_allowed_domains");
      if (cached !== null) {
        cspAllowed = cached;
      }
    }
  } catch (e) {
    console.error("Failed to read CSP_ALLOWED from KV Cache", e);
  }

  const cdnDomain = c.env?.CDN_DOMAIN_URL;
  // Use PUBLIC_API_BASE_URL environment variable - no hardcoded fallbacks
  const currentOrigin = (c.env?.PUBLIC_API_BASE_URL || "").trim();

  const origins = [
    currentOrigin,
    // Allow all localhost ports in development
    "http://localhost:*",
    "http://127.0.0.1:*",
    // Keep specific ports for backward compatibility
    "http://localhost:4321",
    "http://localhost:4322",
    "http://127.0.0.1:4321",
    "http://127.0.0.1:4322",
  ];

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