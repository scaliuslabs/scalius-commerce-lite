/**
 * Pure utility helpers for constructing storefront URLs.
 * This file must remain dependency-free (no DB, no Env).
 * For async DB-backed URL resolution, use SettingsService.getStorefrontPath()
 * in src/modules/settings/settings.service.ts.
 */

/**
 * Constructs a full storefront URL by combining the base URL with a path.
 * @param path - The path to append (e.g., "/products/my-product")
 * @param baseUrl - The storefront base URL
 * @returns The complete storefront URL
 */
export function buildStorefrontPath(path: string, baseUrl: string): string {
  const base = baseUrl || "/";

  // Ensure path starts with /
  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  // If base is just "/", return the path as-is
  if (base === "/") {
    return cleanPath;
  }

  // Remove trailing slash from base if present
  const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;

  return `${cleanBase}${cleanPath}`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Normalizes the public storefront base to one origin.
 *
 * Production storefronts must use HTTPS. Plain HTTP is accepted only for an
 * explicit loopback host so local development does not need a fake certificate.
 * Paths, credentials, queries, and fragments are rejected because downstream
 * discovery and callback helpers treat this value as an origin, not a page URL.
 */
export function normalizeStorefrontOrigin(
  value: string | null | undefined,
): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  const isLoopbackHttp = parsed.protocol === "http:" &&
    LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !isLoopbackHttp) return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  if (!parsed.hostname || parsed.origin === "null") return null;

  return parsed.origin;
}
