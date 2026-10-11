import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { mediaText } from "~/i18n/media";
import { MediaApiClient } from "../api";
import type { LibraryMediaFile, MediaFilterOptions } from "../types";

const MEDIA_PAGE_SIZE = 50;

const DEFAULT_FILTERS: MediaFilterOptions = {
  search: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  view: "ready",
};

export function useMediaFiles(autoLoad = false) {
  // Keep every loaded row available to selection and preview; only the page
  // window changes. A response updates rows and its visible page atomically.
  const [{ files, pageIndex }, setListing] = useState<{ files: LibraryMediaFile[]; pageIndex: number }>({ files: [], pageIndex: 0 });
  const setFiles = useCallback((update: SetStateAction<LibraryMediaFile[]>) => {
    setListing((current) => {
      const next = typeof update === "function" ? update(current.files) : update;
      return { files: next, pageIndex: Math.min(current.pageIndex, Math.max(0, Math.ceil(next.length / MEDIA_PAGE_SIZE) - 1)) };
    });
  }, []);
  const setPageIndex = useCallback((page: number) => {
    setListing((current) => ({
      ...current,
      pageIndex: Math.max(0, Math.min(page, Math.ceil(current.files.length / MEDIA_PAGE_SIZE) - 1)),
    }));
  }, []);
  const [isLoading, setIsLoading] = useState(autoLoad);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<MediaFilterOptions>(DEFAULT_FILTERS);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const failedRequestRef = useRef<{ cursor: string | undefined; filters: MediaFilterOptions } | null>(null);

  const loadFiles = useCallback(async (
    cursor: string | undefined,
    nextFilters: Partial<MediaFilterOptions> = DEFAULT_FILTERS,
  ) => {
    // A replacement may supersede any read; another cursor read cannot.
    if (cursor && busyRef.current) return;
    busyRef.current = true;
    const requestId = ++requestRef.current;
    const merged = { ...DEFAULT_FILTERS, ...nextFilters };
    if (cursor) setIsLoadingMore(true);
    else setIsLoading(true);
    setLoadError(null);
    failedRequestRef.current = null;
    // The requested filters apply at once, so a reload that follows (folder
    // change, retry) never resurrects the previous search.
    setFilters(merged);
    try {
      const data = await MediaApiClient.fetchFiles(cursor, MEDIA_PAGE_SIZE, merged);
      if (requestId !== requestRef.current) return;
      setListing((current) => {
        if (!cursor) return { files: data.files, pageIndex: 0 };
        const known = new Set(current.files.map((file) => file.id));
        const added = data.files.filter((file) => !known.has(file.id));
        return {
          files: [...current.files, ...added],
          // If de-duplication left a partial page, show its new rows first.
          pageIndex: added.length ? Math.floor(current.files.length / MEDIA_PAGE_SIZE) : current.pageIndex,
        };
      });
      setNextCursor(data.pagination.nextCursor);
      setHasMore(data.pagination.hasMore);
      setLoadError(null);
    } catch (error) {
      if (requestId === requestRef.current) {
        failedRequestRef.current = { cursor, filters: merged };
        setLoadError(error instanceof Error ? error.message : mediaText("loadFailed"));
      }
    } finally {
      if (requestId === requestRef.current) {
        busyRef.current = false;
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  const applyFilters = useCallback((next: Partial<MediaFilterOptions>) => {
    void loadFiles(undefined, { ...filters, ...next });
  }, [filters, loadFiles]);

  const loadMore = useCallback(() => {
    // A failed replacement left rows from the old query on screen. Retry
    // that query before a cursor can append rows under the new filters.
    if (failedRequestRef.current && !failedRequestRef.current.cursor) return;
    if (nextCursor && hasMore && !busyRef.current) void loadFiles(nextCursor, filters);
  }, [filters, hasMore, loadFiles, nextCursor]);

  const retryFiles = useCallback(() => {
    const failed = failedRequestRef.current;
    if (failed && !busyRef.current) void loadFiles(failed.cursor, failed.filters);
  }, [loadFiles]);

  const refresh = useCallback(() => void loadFiles(undefined, filters), [filters, loadFiles]);

  useEffect(() => {
    if (autoLoad) void loadFiles(undefined, DEFAULT_FILTERS);
  }, [autoLoad, loadFiles]);

  return {
    files,
    setFiles,
    pageIndex,
    pageSize: MEDIA_PAGE_SIZE,
    setPageIndex,
    retryFiles,
    isLoading,
    isLoadingMore,
    nextCursor,
    hasMore,
    loadError,
    filters,
    loadFiles,
    loadMore,
    applyFilters,
    refresh,
  };
}
