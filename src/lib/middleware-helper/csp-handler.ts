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

  // Vercel
  "vercel.app",
  "vercel.com",

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

async function parseCspAllowedDomains(env?: any): Promise<string[]> {
  let cspAllowed = env?.CSP_ALLOWED || process.env.CSP_ALLOWED || "";
  try {
    if (env?.CACHE_CONTROL) {
      const cached = await env.CACHE_CONTROL.get("security:csp_allowed_domains");
      if (cached !== null) {
        cspAllowed = cached;
      }
    }
  } catch (e) {
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

function getCdnDomains(env?: any): string[] {
  const cdnDomain = env?.CDN_DOMAIN_URL || process.env.CDN_DOMAIN_URL;
  if (!cdnDomain) return [];

  return [`https://${cdnDomain}`, `https://*.${cdnDomain}`];
}

async function getCombinedDomains(env?: any): Promise<string[]> {
  const essentialDomains = getEssentialDomains();
  const cdnDomains = getCdnDomains(env);
  const customDomains = await parseCspAllowedDomains(env);

  return [...new Set([...essentialDomains, ...cdnDomains, ...customDomains])];
}

/**
 * Applies Content Security Policy (CSP) headers to a given Response object.
 *
 * @param response The Astro Response object to modify.
 * @param env Cloudflare runtime environment variables.
 * @returns The Response object with CSP headers applied.
 */
export async function setPageCspHeader(response: Response, env?: any): Promise<Response> {
  const allowedDomains = await getCombinedDomains(env);
  // Use PUBLIC_API_BASE_URL environment variable - no hardcoded fallbacks
  const currentOrigin = (env?.PUBLIC_API_BASE_URL || process.env.PUBLIC_API_BASE_URL || "").trim();

  const scriptSrc = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    ...allowedDomains,
  ];

  const connectSrc = [
    "'self'",
    "http://localhost:*",
    "http://127.0.0.1:*",
    currentOrigin,
    ...allowedDomains,
  ];

  const frameSrc = ["'self'", ...allowedDomains];

  const imgSrc = ["'self'", "data:", "https:", "blob:", ...allowedDomains];

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
