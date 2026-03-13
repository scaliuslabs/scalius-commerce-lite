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
