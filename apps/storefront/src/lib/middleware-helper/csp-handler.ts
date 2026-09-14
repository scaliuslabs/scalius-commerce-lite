// src/lib/middleware-helper/csp-handler.ts
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import {
  normalizePlatformOrigin,
  parseMerchantCspSources,
} from "@scalius/shared/security-csp";

/**
 * Builds the page Content-Security-Policy.
 *
 * Platform origins are passed in explicitly by the middleware from the
 * request context (seeded from /api/v1/platform). Merchant-managed additional
 * sources come from the API's storefront CSP settings; there is no
 * environment-variable source. Reads use request-local coalescing so repeated
 * calls within one SSR render share work without retaining a fetch promise
 * across Worker requests.
 */

/** Platform origins that are always allowed, resolved per request. */
export interface CspPlatformOrigins {
  /** Public API origin (no /api/v1), e.g. https://api.example.com */
  apiBaseUrl?: string;
  /** Absolute storefront origin. */
  storefrontUrl?: string;
  /** Platform media base URL. */
  mediaUrl?: string;
  /** Effective image CDN base (dashboard media setting or platform media host). */
  cdnBaseUrl?: string;
}

// Empty sentinel keeps a failed read deterministic within the current request.
const EMPTY_CSP_DATA = { cspAllowedDomains: "" };

async function parseAdditionalDomains(apiBaseUrl: string): Promise<string[]> {
  let additionalDomains = "";
  try {
    if (apiBaseUrl) {
      const cachedData = await withEdgeCache(
        "global_security_settings",
        async () => {
          try {
            const url = `${apiBaseUrl}/api/v1/storefront/csp`;
            const response = await fetch(url, {
              headers: {
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(4000),
            });

            if (!response.ok) {
              // Always cancel the response body to prevent stalled deadlocks
              await response.body?.cancel();
              // Return empty sentinel (NOT null) for request-local coalescing.
              return EMPTY_CSP_DATA;
            }
            const json = (await response.json()) as {
              cspAllowedDomains?: string;
              data?: { cspAllowedDomains?: string };
            };
            return {
              cspAllowedDomains:
                json.data?.cspAllowedDomains ?? json.cspAllowedDomains ?? "",
            };
          } catch {
            // Return empty sentinel for request-local coalescing.
            return EMPTY_CSP_DATA;
          }
        },
        { ttlSeconds: CACHE_TTL.SHORT },
      );

      if (cachedData?.cspAllowedDomains) {
        additionalDomains = cachedData.cspAllowedDomains;
      }
    }
  } catch (e: unknown) {
    console.error("Failed to fetch merchant CSP sources via EdgeCache", e);
  }

  if (!additionalDomains) {
    return [];
  }

  return parseMerchantCspSources(additionalDomains);
}

// Define essential hardcoded CSP directives that should never be configurable
// These are the most critical domains needed for the application to function
const ESSENTIAL_SCRIPT_SRC = [
  "'self'",
  "'unsafe-inline'", // Consider reducing usage if possible
  "data:",
];

const ESSENTIAL_CONNECT_SRC = ["'self'"];

const ESSENTIAL_FRAME_SRC = ["'self'"];

const ESSENTIAL_IMG_SRC = ["'self'", "data:", "https:", "blob:"];

const ESSENTIAL_WORKER_SRC = [
  "'self'",
  "blob:", // Often used by Partytown or other libraries for web workers
];

// Universal third-party domains needed for common integrations
const COMMON_THIRD_PARTY_DOMAINS = [
  // Google Services (Analytics, Tag Manager, Firebase, APIs)
  "https://*.googleapis.com",
  "https://*.gstatic.com",
  "https://*.google.com",
  "https://www.googletagmanager.com",
  "https://*.google-analytics.com",
  "https://*.analytics.google.com",
  "https://cdn.jsdelivr.net",
  // Cloudflare Web Analytics / Insights
  "https://static.cloudflareinsights.com",
  "https://*.cloudflareinsights.com",
  "https://cloudflareinsights.com",
  // TikTok Pixel
  "https://analytics.tiktok.com",
  // Meta/Facebook Pixel
  "https://connect.facebook.net",
  "https://www.facebook.com",
  "https://*.facebook.com",
  // Stripe payment gateway
  "https://js.stripe.com",
  "https://*.stripe.com",
  // SSLCommerz payment gateway
  "https://sandbox.sslcommerz.com",
  "https://securepay.sslcommerz.com",
  "https://*.sslcommerz.com",
];

// Generate script-src directives
function getScriptSrcDirectives(additionalDomains: string[]): string[] {
  return [
    ...ESSENTIAL_SCRIPT_SRC,
    ...COMMON_THIRD_PARTY_DOMAINS,
    ...additionalDomains,
  ];
}

// Generate connect-src directives
function getConnectSrcDirectives(
  additionalDomains: string[],
  apiBaseUrl: string,
): string[] {
  const directives = [
    ...ESSENTIAL_CONNECT_SRC,
    ...COMMON_THIRD_PARTY_DOMAINS,
    "https://connect.facebook.net", // For Facebook Pixel script/connections
    "https://www.facebook.com", // For Facebook Pixel (tr endpoint)
    "https://*.facebook.com", // For FB API calls by the pixel
    "https://analytics.tiktok.com", // For TikTok Pixel script/connections
    ...additionalDomains,
  ];

  const apiOrigin = normalizePlatformOrigin(apiBaseUrl);
  if (apiOrigin) directives.push(apiOrigin);

  return directives;
}

// Generate frame-src directives
function getFrameSrcDirectives(additionalDomains: string[]): string[] {
  return [
    ...ESSENTIAL_FRAME_SRC,
    "https://*.google.com", // For Google services like reCAPTCHA
    "https://*.facebook.com", // For Facebook UI elements or login iframes
    "https://js.stripe.com", // Stripe card elements use iframes
    "https://*.stripe.com",
    "https://*.sslcommerz.com", // SSLCommerz payment gateway
    "https://www.youtube-nocookie.com", // Merchant-authored YouTube embeds
    "https://player.vimeo.com", // Merchant-authored Vimeo embeds
    ...additionalDomains,
  ];
}

// Generate img-src directives
function getImgSrcDirectives(
  additionalDomains: string[],
  platformDomains: string[],
  localDevSources: string[],
): string[] {
  return [
    ...ESSENTIAL_IMG_SRC,
    "https://www.facebook.com", // Facebook Pixel noscript tag
    "https://analytics.tiktok.com", // TikTok Pixel beacon/image fallbacks
    ...localDevSources,
    ...platformDomains,
    ...additionalDomains,
  ];
}

// Generate worker-src directives
function getWorkerSrcDirectives(additionalDomains: string[]): string[] {
  return [...ESSENTIAL_WORKER_SRC, ...additionalDomains];
}

/**
 * Collect the platform-owned origins so they are automatically CSP-allowed.
 * Handles both https (production) and http (local dev) schemes; malformed
 * values are dropped rather than widened.
 */
function getPlatformDomains(origins: CspPlatformOrigins): string[] {
  const urls: string[] = [];
  for (const raw of [
    origins.cdnBaseUrl,
    origins.mediaUrl,
    origins.apiBaseUrl,
    origins.storefrontUrl,
  ]) {
    const candidate = raw?.trim();
    if (!candidate) continue;

    const origin = normalizePlatformOrigin(candidate);
    if (origin) urls.push(origin);
  }

  return [...new Set(urls)];
}

/**
 * Applies Content Security Policy (CSP) headers to a given Response object.
 * Platform origins come from the per-request context; nothing is hardcoded.
 */
export async function setPageCspHeader(
  response: Response,
  origins: CspPlatformOrigins = {},
): Promise<Response> {
  const apiBaseUrl = origins.apiBaseUrl?.trim() ?? "";
  const additionalDomains = await parseAdditionalDomains(apiBaseUrl);
  const platformDomains = getPlatformDomains(origins);

  // Dev mode detection — allow http://localhost in dev, never in production
  const isDev = apiBaseUrl.includes("localhost") || apiBaseUrl.includes("127.0.0.1");
  const localDevSources = isDev
    ? ["http://localhost:*", "http://127.0.0.1:*"]
    : [];

  const cspDirectives = [
    `script-src ${getScriptSrcDirectives(additionalDomains).join(" ")}`,
    `connect-src ${getConnectSrcDirectives(additionalDomains, apiBaseUrl).join(" ")}`,
    `frame-src ${getFrameSrcDirectives(additionalDomains).join(" ")}`,
    `img-src ${getImgSrcDirectives(additionalDomains, platformDomains, localDevSources).join(" ")}`,
    "object-src 'none'",
    `worker-src ${getWorkerSrcDirectives(additionalDomains).join(" ")}`,
    "base-uri 'self'",
    "form-action 'self' https://www.facebook.com https://*.sslcommerz.com https://*.stripe.com",
    "frame-ancestors 'self'",
  ];

  response.headers.set(
    "Content-Security-Policy",
    [...new Set(cspDirectives)].join("; "),
  );
  return response;
}
