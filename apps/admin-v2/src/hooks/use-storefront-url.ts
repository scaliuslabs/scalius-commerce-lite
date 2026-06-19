import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";

/**
 * Constructs a full storefront URL by combining the base URL with a path.
 */
function buildUrl(path: string, baseUrl: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (baseUrl === "/") return cleanPath;
  const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${cleanBase}${cleanPath}`;
}

/**
 * Thin wrapper around TanStack Query for the storefront URL.
 * Replaces the previous hand-rolled singleton + promise deduplication cache.
 * TanStack Query handles deduplication, caching, and background refresh.
 *
 * Returns the same interface as before: { storefrontUrl, isLoading, error,
 * buildStorefrontPath, getStorefrontPath }.
 */
export function useStorefrontUrl() {
  const { data, isLoading, error } = useQuery(storefrontUrlQueryOptions());

  const storefrontUrl =
    (data as Record<string, unknown> | undefined)?.storefrontUrl as string ??
    null;

  const buildStorefrontPath = useCallback(
    (path: string): string | null => {
      if (!storefrontUrl) return null;
      return buildUrl(path, storefrontUrl);
    },
    [storefrontUrl],
  );

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
