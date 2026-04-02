// src/lib/middleware-helper/csp-handler.ts

/**
 * Essential domains that are commonly needed for modern web applications
 * These are hardcoded to avoid requiring users to manually add every service
 */
const ESSENTIAL_DOMAINS = [
  // Google Services (Firebase, Analytics, APIs, etc.)
  "googleapis.com",
  "gstatic.com",
  "google.com",
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "cdn.jsdelivr.net",

  // Firebase specific
  "firebaseapp.com",
  "firestore.googleapis.com",

  // Meta/Facebook
  "facebook.com",
  "facebook.net",
  "connect.facebook.net",

  // Common CDNs
  "jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",

  // Cloudflare
  "cloudflareinsights.com",
  "static.cloudflareinsights.com",
];

function getEssentialDomains(): string[] {
  return ESSENTIAL_DOMAINS.flatMap((domain) => [
    `https://${domain}`,
    `https://*.${domain}`,
  ]);
}

async function parseCspAllowedDomains(env?: Record<string, unknown>): Promise<string[]> {
  let cspAllowed = String(env?.CSP_ALLOWED || "");
  try {
    if (env?.CACHE) {
      const cache = env.CACHE as { get(key: string): Promise<string | null> };
      const cached = await cache.get("security:csp_allowed_domains");
      if (cached !== null) {
        cspAllowed = cached;
      }
    }
  } catch (e: unknown) {
    console.error("Failed to read CSP_ALLOWED from KV Cache", e);
  }

  if (!cspAllowed.trim()) return [];

  return cspAllowed
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
}

/**
 * Collect all platform-owned URLs from env so they are automatically CSP-allowed.
 * Handles both https (production) and http (local dev) schemes.
 */
function getPlatformDomains(env?: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const envKeys = [
    "CDN_DOMAIN_URL",
    "R2_PUBLIC_URL",
    "PUBLIC_API_BASE_URL",
    "STOREFRONT_URL",
    "BETTER_AUTH_URL",
  ];

  for (const key of envKeys) {
    const raw: string | undefined = env?.[key] as string | undefined;
    if (!raw) continue;

    // CDN_DOMAIN_URL is stored as a bare domain (no scheme)
    const value = raw.trim();
    if (!value) continue;

    try {
      // If it already has a scheme, parse directly; otherwise treat as bare domain
      const hasScheme = /^https?:\/\//.test(value);
      if (hasScheme) {
        const parsed = new URL(value);
        urls.push(parsed.origin);
        urls.push(`${parsed.protocol}//*.${parsed.hostname}`);
      } else {
        urls.push(`https://${value}`, `https://*.${value}`);
      }
    } catch {
      // Not a valid URL, try as bare domain
      urls.push(`https://${value}`, `https://*.${value}`);
    }
  }

  return urls;
}

async function getCombinedDomains(env?: Record<string, unknown>): Promise<string[]> {
  const essentialDomains = getEssentialDomains();
  const platformDomains = getPlatformDomains(env);
  const customDomains = await parseCspAllowedDomains(env);

  return [...new Set([...essentialDomains, ...platformDomains, ...customDomains])];
}

/**
 * Applies Content Security Policy (CSP) headers to a given Response object.
 *
 * @param response The Astro Response object to modify.
 * @param env Cloudflare runtime environment variables.
 * @returns The Response object with CSP headers applied.
 */
export async function setPageCspHeader(response: Response, env?: Record<string, unknown>): Promise<Response> {
  const allowedDomains = await getCombinedDomains(env);
  // Use PUBLIC_API_BASE_URL environment variable - no hardcoded fallbacks
  const currentOrigin = String(env?.PUBLIC_API_BASE_URL || "").trim();

  // Only allow localhost in dev mode — never in production CSP
  const isDev = currentOrigin.includes("localhost") || currentOrigin.includes("127.0.0.1");
  const localDevSources = isDev ? ["http://localhost:*", "http://127.0.0.1:*"] : [];

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    ...allowedDomains,
  ];

  const connectSrc = [
    "'self'",
    ...localDevSources,
    currentOrigin,
    ...allowedDomains,
  ];

  const frameSrc = ["'self'", ...allowedDomains];

  const imgSrc = [
    "'self'",
    "data:",
    "https:",
    "blob:",
    ...localDevSources,
    ...allowedDomains,
  ];

  const workerSrc = ["'self'", "blob:", ...allowedDomains];

  const cspDirectives = [
    `script-src ${scriptSrc.join(" ")}`,
    `connect-src ${connectSrc.join(" ")}`,
    `frame-src ${frameSrc.join(" ")}`,
    `img-src ${imgSrc.join(" ")}`,
    "object-src 'none'",
    `worker-src ${workerSrc.join(" ")}`,
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ];

  response.headers.set("Content-Security-Policy", [...new Set(cspDirectives)].join("; "));
  return response;
}
