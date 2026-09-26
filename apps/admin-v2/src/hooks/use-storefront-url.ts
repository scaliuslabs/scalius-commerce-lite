import { useCallback, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { withStorefrontSeenSeq } from "@scalius/shared/storefront-cache-path";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";
import { readStoreCommitSeq, subscribeStoreCommitSeq } from "~/lib/store-commit-seq";

/**
 * Constructs a full storefront URL by combining the base URL with a path,
 * carrying the newest change clock this tab saw on a save (`_sv`) so the
 * store shows the merchant's own change at once.
 */
function buildUrl(path: string, baseUrl: string, seenSeq: number | null): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (baseUrl === "/") return withStorefrontSeenSeq(cleanPath, seenSeq);
  const cleanBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return withStorefrontSeenSeq(`${cleanBase}${cleanPath}`, seenSeq);
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
  const seenSeq = useSyncExternalStore(subscribeStoreCommitSeq, readStoreCommitSeq, readStoreCommitSeq);

  const storefrontUrl =
    (data as Record<string, unknown> | undefined)?.storefrontUrl as string ??
    null;

  const buildStorefrontPath = useCallback(
    (path: string): string | null => {
      if (!storefrontUrl) return null;
      return buildUrl(path, storefrontUrl, seenSeq);
    },
    [storefrontUrl, seenSeq],
  );

  const getStorefrontPath = useCallback(
    (path: string, fallback?: string): string => {
      if (!storefrontUrl) return fallback || path;
      return buildUrl(path, storefrontUrl, seenSeq);
    },
    [storefrontUrl, seenSeq],
  );

  return {
    storefrontUrl,
    isLoading,
    error,
    buildStorefrontPath,
    getStorefrontPath,
  };
}
