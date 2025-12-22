import { useState, useEffect, useCallback } from "react";

/**
 * Global cache for storefront URL to avoid repeated API calls across components
 */
let globalStorefrontUrl: string | null = null;
let globalPromise: Promise<string> | null = null;

/**
 * Fetches the storefront URL from the API
 */
async function fetchStorefrontUrl(): Promise<string> {
  // Return cached value if available
  if (globalStorefrontUrl) {
    return globalStorefrontUrl;
  }

  // Return existing promise if one is in flight
  if (globalPromise) {
    return globalPromise;
  }

  // Create new promise
  globalPromise = fetch("/api/settings/storefront-url")
    .then((response) => {
      if (!response.ok) {
        throw new Error("Failed to fetch storefront URL");
      }
      return response.json();
    })
    .then((data) => {
      const url = data.storefrontUrl || "/";
      globalStorefrontUrl = url;
      globalPromise = null; // Clear the promise
      return url;
    })
    .catch((error) => {
      console.warn("Could not fetch storefront URL, using default:", error);
      globalStorefrontUrl = "/";
      globalPromise = null; // Clear the promise
      return "/";
    });

  return globalPromise;
}

/**
 * Constructs a full storefront URL by combining the base URL with a path
 */
function buildUrl(path: string, baseUrl: string): string {
  // Ensure path starts with /
  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  // If base is just "/", return the path as-is
  if (baseUrl === "/") {
    return cleanPath;
  }

  // Remove trailing slash from base if present
  const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  return `${cleanBase}${cleanPath}`;
}

/**
 * React hook for managing storefront URLs
 * @returns Object containing the storefront URL state and utility functions
 */
export function useStorefrontUrl() {
  const [storefrontUrl, setStorefrontUrl] = useState<string | null>(
    globalStorefrontUrl,
  );
  const [isLoading, setIsLoading] = useState(!globalStorefrontUrl);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!globalStorefrontUrl) {
      fetchStorefrontUrl()
        .then((url) => {
          setStorefrontUrl(url);
          setIsLoading(false);
        })
        .catch((err) => {
          setError(err);
          setIsLoading(false);
        });
    } else {
      setIsLoading(false);
    }
  }, []);

  /**
   * Build a complete storefront URL for a given path
   * @param path - The path to append (e.g., "/products/my-product")
   * @returns The complete URL or null if storefront URL not loaded yet
   */
  const buildStorefrontPath = useCallback(
    (path: string): string | null => {
      if (!storefrontUrl) return null;
      return buildUrl(path, storefrontUrl);
    },
    [storefrontUrl],
  );

  /**
   * Get a complete storefront URL for a given path, with fallback
   * @param path - The path to append
   * @param fallback - Fallback URL if storefront URL not available (defaults to the path)
   * @returns The complete URL or fallback
   */
  const getStorefrontPath = useCallback(
    (path: string, fallback?: string): string => {
      if (!storefrontUrl) return fallback || path;
      return buildUrl(path, storefrontUrl);
    },
    [storefrontUrl],
  );

  return {
    storefrontUrl,
    isLoading,
    error,
    buildStorefrontPath,
    getStorefrontPath,
  };
}

/**
 * Clear the global cache (useful for testing or when settings change)
 */
export function clearStorefrontUrlCache(): void {
  globalStorefrontUrl = null;
  globalPromise = null;
}
