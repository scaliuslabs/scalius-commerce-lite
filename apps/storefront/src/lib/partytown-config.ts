/**
 * Partytown Configuration
 * Uses same-origin reverse proxy at /api/__ptproxy to fetch third-party scripts.
 */

/**
 * Partytown resolveUrl function.
 * Proxies known third-party analytics scripts through our same-origin endpoint
 * so the Partytown web worker can fetch them without CORS issues.
 *
 * This is a plain function (not `new Function()`) so it does NOT require
 * 'unsafe-eval' in the Content-Security-Policy.
 */
function resolveUrl(url: URL, location: Location, type: string): URL {
  // Proxy known analytics scripts through same-origin reverse proxy
  if (
    type === "script" &&
    (url.hostname === "connect.facebook.net" ||
      url.hostname === "www.googletagmanager.com" ||
      url.hostname === "www.google-analytics.com")
  ) {
    const proxyUrl = new URL("/api/__ptproxy", location.origin);
    proxyUrl.searchParams.set("url", url.href);
    return proxyUrl;
  }

  return url;
}

/**
 * Complete Partytown configuration object
 */
export const partytownConfig = {
  // Forward these methods to the main thread
  forward: ["dataLayer.push", "fbq", "ga", "gtag"] as string[],

  // Custom URL resolver for proxying scripts
  resolveUrl,

  // Performance optimizations
  debug: false as boolean,
  logCalls: false as boolean,
  logGetters: false as boolean,
  logSetters: false as boolean,
  logImageRequests: false as boolean,
  logMainAccess: false as boolean,
  logSendBeaconRequests: false as boolean,
  logStackTraces: false as boolean,
  logScriptExecution: false as boolean,
};
