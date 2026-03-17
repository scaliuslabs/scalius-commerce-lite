import { useState, useEffect, useCallback, useRef } from "react";

const PROXY_BASE = "/api/v1/admin";

interface UseApiOptions<T> {
  /** SSR-provided initial data — avoids a loading flash when set. */
  initialData?: T;
  /** Skip the fetch entirely (e.g., when a required ID is undefined). */
  enabled?: boolean;
  /** URL search params appended to the request. */
  params?: Record<string, string>;
  /** Called after a successful fetch with the parsed data. */
  onSuccess?: (data: T) => void;
  /** Called when a fetch fails with the error. */
  onError?: (error: Error) => void;
}

interface UseApiReturn<T> {
  data: T | undefined;
  error: Error | null;
  isLoading: boolean;
  refetch: () => void;
}

/**
 * Build a full proxy URL from a path and optional query params.
 * The path should NOT include the /api/v1/admin prefix.
 */
function buildUrl(path: string, params?: Record<string, string>): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${PROXY_BASE}${normalizedPath}`;

  if (!params || Object.keys(params).length === 0) {
    return url;
  }

  const searchParams = new URLSearchParams(params);
  return `${url}?${searchParams.toString()}`;
}

/**
 * Client-side React hook for fetching data through the admin proxy.
 *
 * The admin proxy returns `{ success: true, ...T }`. This hook strips the
 * `success` flag and provides `T` as `data`.
 *
 * Features:
 * - Generic type parameter for response shape
 * - `initialData` to avoid loading flash with SSR-provided data
 * - `enabled` to conditionally skip fetching
 * - `params` for URL search parameters
 * - `onSuccess` / `onError` callbacks
 * - AbortController cleanup on unmount
 * - Keeps previous data during refetch (no flash to loading state)
 */
export function useApi<T>(
  path: string,
  options?: UseApiOptions<T>,
): UseApiReturn<T> {
  const {
    initialData,
    enabled = true,
    params,
    onSuccess,
    onError,
  } = options ?? {};

  const [data, setData] = useState<T | undefined>(initialData);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(
    initialData === undefined && enabled,
  );

  // Use refs for callbacks to avoid re-triggering the effect when they change
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Track a refetch trigger
  const [fetchCount, setFetchCount] = useState(0);

  const refetch = useCallback(() => {
    setFetchCount((c) => c + 1);
  }, []);

  // Serialize params to a stable string for the dependency array
  const paramsKey = params ? JSON.stringify(params) : "";

  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    const abortController = new AbortController();

    async function doFetch() {
      // Only show loading if we have no data to display
      if (data === undefined) {
        setIsLoading(true);
      }
      setError(null);

      try {
        const url = buildUrl(path, params);
        const response = await fetch(url, {
          signal: abortController.signal,
        });

        if (!response.ok) {
          let message = `API error: ${response.status} ${response.statusText}`;
          try {
            const body = await response.json();
            if (body && typeof body === "object" && "error" in body) {
              message = String(
                (body as Record<string, unknown>).error,
              );
            }
          } catch {
            // Use default message
          }
          throw new Error(message);
        }

        const body = (await response.json()) as Record<string, unknown>;

        if (body.success === false) {
          throw new Error(
            (body.error as string) ?? "Unknown API error",
          );
        }

        // Handle both proxy-unwrapped and raw API envelope shapes:
        // - Proxy (production): { success, ...T } → strip success, return rest
        // - Raw API (dev via Vite proxy): { success, data: T } → unwrap data
        let result: T;
        if (
          body.data !== undefined &&
          body.data !== null &&
          typeof body.data === "object" &&
          !Array.isArray(body.data) &&
          Object.keys(body).length === 2 // only { success, data }
        ) {
          // Raw envelope: { success: true, data: T } — unwrap
          result = body.data as T;
        } else if (body.data !== undefined && Array.isArray(body.data) && Object.keys(body).length === 2) {
          // Raw envelope with array: { success: true, data: [...] } — unwrap
          result = body.data as T;
        } else {
          // Proxy-unwrapped: { success, ...T } — strip success
          const { success: _, ...rest } = body;
          result = rest as T;
        }

        setData(result);
        setError(null);
        onSuccessRef.current?.(result);
      } catch (err) {
        // Ignore abort errors — they happen on cleanup
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const error =
          err instanceof Error ? err : new Error(String(err));
        setError(error);
        onErrorRef.current?.(error);
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    doFetch();

    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, paramsKey, enabled, fetchCount]);

  return { data, error, isLoading, refetch };
}
