/**
 * Partytown Configuration
 * Reads API base URL from wrangler.jsonc vars (the single source of truth).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Get API base URL from wrangler.jsonc vars or process.env
const getApiBaseUrl = (): string => {
  // Try process.env first (manual override)
  let apiBaseUrl =
    process.env.PUBLIC_API_BASE_URL ||
    process.env.PUBLIC_API_URL?.replace("/api/v1", "");

  // Read from wrangler.jsonc if not in process.env
  if (!apiBaseUrl) {
    try {
      const wranglerPath = resolve(process.cwd(), 'wrangler.jsonc');
      const raw = readFileSync(wranglerPath, 'utf-8');
      const json = raw.replace(/^\s*\/\/.*$/gm, '');
      const config = JSON.parse(json);
      apiBaseUrl = config.vars?.PUBLIC_API_BASE_URL ||
        config.vars?.PUBLIC_API_URL?.replace("/api/v1", "");
    } catch {
      // Silently fall through
    }
  }

  return apiBaseUrl || "";
};

// Capture the API base URL at build time
export const API_BASE_URL = getApiBaseUrl();

/**
 * Creates the Partytown resolveUrl function with embedded API base URL
 * This function will be serialized and run in a web worker context
 */
export const createPartytownResolveUrl = (): ((
  url: URL,
  location: Location,
  type: string,
) => URL) => {
  const baseUrl = API_BASE_URL;

  // Return a function with the base URL embedded as a string literal
  return new Function(
    "url",
    "_location",
    "type",
    `
    // Proxy Facebook Pixel scripts through our backend
    if (type === "script" && url.hostname === "connect.facebook.net") {
      var apiBaseUrl = "${baseUrl}";
      
      if (!apiBaseUrl) {
        console.error("No API base URL configured for Partytown proxy");
        return url; // Fallback to default resolution
      }

      var proxyUrl = new URL(apiBaseUrl + "/api/__ptproxy");
      proxyUrl.searchParams.set("url", url.href);
      
      console.log(
        "Partytown proxying: " + url.href + " -> " + proxyUrl.href
      );
      
      return proxyUrl;
    }
    
    // Use default resolution for other scripts
    return url;
  `,
  ) as (url: URL, location: Location, type: string) => URL;
};

/**
 * Complete Partytown configuration object
 */
export const partytownConfig = {
  // Forward these methods to the main thread
  forward: ["dataLayer.push", "fbq", "ga", "gtag"] as string[],

  // Custom URL resolver for proxying scripts
  resolveUrl: createPartytownResolveUrl(),

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
