import { db } from "@/db";
import { siteSettings } from "@/db/schema";

/**
 * Cache for storefront URL to avoid repeated database queries
 */
let cachedStorefrontUrl: string | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the storefront URL from the database with caching
 */
async function getStorefrontUrl(): Promise<string> {
  const now = Date.now();

  // Return cached value if still valid
  if (cachedStorefrontUrl && now - cacheTimestamp < CACHE_TTL) {
    return cachedStorefrontUrl;
  }

  try {
    const [storefrontSettings] = await db
      .select({ storefrontUrl: siteSettings.storefrontUrl })
      .from(siteSettings)
      .limit(1);

    const url = storefrontSettings?.storefrontUrl || "/";

    // Update cache
    cachedStorefrontUrl = url;
    cacheTimestamp = now;

    return url;
  } catch (error) {
    console.warn("Could not fetch storefront URL, using default:", error);
    return "/";
  }
}

/**
 * Constructs a full storefront URL by combining the base URL with a path
 * @param path - The path to append (e.g., "/products/my-product")
 * @param baseUrl - Optional base URL override
 * @returns The complete storefront URL
 */
function buildStorefrontUrl(path: string, baseUrl?: string): string {
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

/**
 * Server-side function to get a complete storefront URL for a given path
 * @param path - The path to append to the storefront URL
 * @returns Promise resolving to the complete URL
 */
export async function getStorefrontPath(path: string): Promise<string> {
  const baseUrl = await getStorefrontUrl();
  return buildStorefrontUrl(path, baseUrl);
}

/**
 * Synchronous version that uses a provided base URL
 * @param path - The path to append
 * @param baseUrl - The storefront base URL
 * @returns The complete URL
 */
export function buildStorefrontPath(path: string, baseUrl: string): string {
  return buildStorefrontUrl(path, baseUrl);
}

/**
 * Clear the cached storefront URL (useful for testing or when settings change)
 */
export function clearStorefrontUrlCache(): void {
  cachedStorefrontUrl = null;
  cacheTimestamp = 0;
}
