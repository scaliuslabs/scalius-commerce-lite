export function getCorsOriginFunction() {
  return (origin: string): string | null => {
    const allowedOrigins = getAllowedCorsOrigins();

    // SECURITY: Reject requests with no origin in production
    // Mobile apps and curl don't need CORS headers anyway
    if (!origin) return null;

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
}

function getAllowedCorsOrigins(): string[] {
  const cspAllowed = process.env.CSP_ALLOWED || "";
  const cdnDomain = process.env.CDN_DOMAIN_URL;
  // Use PUBLIC_API_BASE_URL environment variable - no hardcoded fallbacks
  const currentOrigin = process.env.PUBLIC_API_BASE_URL || "";

  const origins = [
    currentOrigin,
    // SECURITY: Only allow specific localhost ports, not wildcards
    "http://localhost:4321",
    "http://localhost:4322",
    "http://localhost:3000",
    "http://127.0.0.1:4321",
    "http://127.0.0.1:4322",
    "http://127.0.0.1:3000",
  ];

  if (cdnDomain) {
    origins.push(`https://${cdnDomain}`, `https://*.${cdnDomain}`);
  }

  if (cspAllowed.trim()) {
    // SECURITY: Only add exact domains from CSP_ALLOWED, no automatic wildcard expansion
    const customOrigins = cspAllowed
      .split(",")
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0)
      .map((domain) => {
        // Remove https:// if present to normalize
        const cleanDomain = domain.replace(/^https?:\/\//, "");
        return `https://${cleanDomain}`;
      });

    origins.push(...customOrigins);
  }
  return origins;
}
