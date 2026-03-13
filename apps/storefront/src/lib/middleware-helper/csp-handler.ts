// src/lib/middleware-helper/csp-handler.ts
import { withEdgeCache, CACHE_TTL } from "../edge-cache";

/**
 * Parse additional domains from CSP_ALLOWED environment variable
 * and add them with wildcard subdomains to CSP directives.
 *
 * Uses withEdgeCache which handles deduplication via its inflight map,
 * so no per-request caching is needed here.
 */

// Empty sentinel — returned on fetch failure so withEdgeCache caches it
// and doesn't re-fetch on every request
const EMPTY_CSP_DATA = { cspAllowedDomains: "" };

async function parseAdditionalDomains(env?: any): Promise<string[]> {
  let additionalDomains = (env?.CSP_ALLOWED || process.env.CSP_ALLOWED)?.trim() || "";
  try {
    const apiUrl = (env?.PUBLIC_API_BASE_URL || import.meta.env.PUBLIC_API_BASE_URL || "")?.trim();
    if (apiUrl) {
      const cachedData = await withEdgeCache(
        "global_security_settings",
        async () => {
          try {
            const url = `${apiUrl}/api/v1/storefront/csp`;
            const response = await fetch(url, {
              headers: {
                "Accept": "application/json"
              },
              signal: AbortSignal.timeout(4000),
            });

            if (!response.ok) {
              // Always cancel the response body to prevent stalled deadlocks
              await response.body?.cancel();
              // Return empty sentinel (NOT null) so this gets cached
              // and we don't re-fetch on every single request
              return EMPTY_CSP_DATA;
            }
            const json = await response.json() as { cspAllowedDomains?: string };
            return { cspAllowedDomains: json.cspAllowedDomains };
          } catch {
            // Return empty sentinel so failure is cached too
            return EMPTY_CSP_DATA;
          }
        },
        { ttlSeconds: CACHE_TTL.SHORT }
      );

      if (cachedData?.cspAllowedDomains) {
        additionalDomains = cachedData.cspAllowedDomains;
      }
    }
  } catch (e) {
    console.error("Failed to fetch CSP_ALLOWED via EdgeCache", e);
  }

  if (!additionalDomains) {
    return [];
  }

  return additionalDomains
    .split(",")
    .map((domain: string) => domain.trim())
    .filter((domain: string) => domain.length > 0)
    .flatMap((domain: string) => {
      // Remove protocol if present
      const cleanDomain = domain.replace(/^https?:\/\//, "");
      // Add both the domain and its wildcard subdomain
      return [`https://${cleanDomain}`, `https://*.${cleanDomain}`];
    });
}

// Define essential hardcoded CSP directives that should never be configurable
// These are the most critical domains needed for the application to function
const ESSENTIAL_SCRIPT_SRC = [
  "'self'",
  "'unsafe-inline'", // Consider reducing usage if possible
  "data:",
  "'unsafe-eval'", // Often needed by frameworks, but review alternatives
];

const ESSENTIAL_CONNECT_SRC = [
  "'self'",
  "http://localhost:*", // Explicitly allow localhost for dev
  "http://12.0.0.1:*", // Allow loopback alias
  "http://127.0.2.2:4321", // User specified local IP
  "http://192.168.0.152:4321", // Allow specific local network IP from logs
];

const ESSENTIAL_FRAME_SRC = ["'self'"];

const ESSENTIAL_IMG_SRC = [
  "'self'",
  "data:", // Allow data URIs for images
  "https:", // Allow any HTTPS source for images
  "blob:", // Allow blob URLs for images
];

const ESSENTIAL_WORKER_SRC = [
  "'self'",
  "blob:", // Often used by Partytown or other libraries for web workers
];

// Common third-party domains that are typically safe and commonly used
const COMMON_THIRD_PARTY_DOMAINS = [
  "https://*.googleapis.com",
  "https://*.gstatic.com",
  "https://*.google.com",
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://vitals.vercel-insights.com",
  "https://cdn.jsdelivr.net",
  // Cloudflare Web Analytics / Insights
  "https://static.cloudflareinsights.com",
  "https://*.cloudflareinsights.com",
  "https://cloudflareinsights.com",
  // Stripe payment gateway
  "https://js.stripe.com",
  "https://*.stripe.com",
  // SSLCommerz payment gateway
  "https://sandbox.sslcommerz.com",
  "https://securepay.sslcommerz.com",
  "https://*.sslcommerz.com",
];

// Generate script-src directives
async function getScriptSrcDirectives(env?: any): Promise<string[]> {
  const additionalDomains = await parseAdditionalDomains(env);
  return [
    ...ESSENTIAL_SCRIPT_SRC,
    ...COMMON_THIRD_PARTY_DOMAINS,
    ...additionalDomains,
  ];
}

// Generate connect-src directives
async function getConnectSrcDirectives(env?: any): Promise<string[]> {
  const additionalDomains = await parseAdditionalDomains(env);
  const apiUrl = (env?.PUBLIC_API_BASE_URL || import.meta.env.PUBLIC_API_BASE_URL || "")?.trim();
  const directives = [
    ...ESSENTIAL_CONNECT_SRC,
    ...COMMON_THIRD_PARTY_DOMAINS,
    "https://connect.facebook.net", // For Facebook Pixel script/connections
    "https://www.facebook.com", // For Facebook Pixel (tr endpoint)
    "https://*.facebook.com", // For FB API calls by the pixel
    ...additionalDomains,
  ];

  if (apiUrl) {
    const cleanApiUrl = apiUrl.replace(/^https?:\/\//, "");
    directives.push(`https://${cleanApiUrl}`, `https://*.${cleanApiUrl}`);
  }

  return directives;
}

// Generate frame-src directives
async function getFrameSrcDirectives(env?: any): Promise<string[]> {
  const additionalDomains = await parseAdditionalDomains(env);
  return [
    ...ESSENTIAL_FRAME_SRC,
    "https://*.google.com", // For Google services like reCAPTCHA
    "https://*.facebook.com", // For Facebook UI elements or login iframes
    "https://js.stripe.com", // Stripe card elements use iframes
    "https://*.stripe.com",
    "https://*.sslcommerz.com", // SSLCommerz payment gateway
    ...additionalDomains,
  ];
}

// Generate img-src directives
async function getImgSrcDirectives(env?: any): Promise<string[]> {
  const additionalDomains = await parseAdditionalDomains(env);
  const cdnUrl = (env?.CDN_DOMAIN_URL || import.meta.env.CDN_DOMAIN_URL || "")?.trim();
  const directives = [
    ...ESSENTIAL_IMG_SRC,
    "https://www.facebook.com", // For Facebook Pixel noscript tag
    ...additionalDomains,
  ];

  if (cdnUrl) {
    const cleanCdnUrl = cdnUrl.replace(/^https?:\/\//, "");
    directives.push(`https://${cleanCdnUrl}`, `https://*.${cleanCdnUrl}`);
  }

  return directives;
}

// Generate worker-src directives
async function getWorkerSrcDirectives(env?: any): Promise<string[]> {
  const additionalDomains = await parseAdditionalDomains(env);
  return [...ESSENTIAL_WORKER_SRC, ...additionalDomains];
}

/**
 * Applies Content Security Policy (CSP) headers to a given Response object.
 *
 * @param response The Astro Response object to modify.
 * @param env Cloudflare runtime environment object
 * @returns The Response object with CSP headers applied.
 */
export async function setPageCspHeader(response: Response, env?: any): Promise<Response> {
  const cspDirectives = [
    `script-src ${(await getScriptSrcDirectives(env)).join(" ")}`,
    `connect-src ${(await getConnectSrcDirectives(env)).join(" ")}`,
    `frame-src ${(await getFrameSrcDirectives(env)).join(" ")}`,
    `img-src ${(await getImgSrcDirectives(env)).join(" ")}`,
    "object-src 'none'", // Disallow plugins like Flash
    `worker-src ${(await getWorkerSrcDirectives(env)).join(" ")}`,
    "base-uri 'self'",
    "form-action 'self' https://www.facebook.com https://*.sslcommerz.com https://*.stripe.com", // Allow form submissions
    "frame-ancestors 'self'", // Prevent clickjacking
  ];

  response.headers.set("Content-Security-Policy", [...new Set(cspDirectives)].join("; "));
  return response;
}
