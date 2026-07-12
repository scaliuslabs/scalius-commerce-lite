import { useCallback, useEffect, useRef, useState } from "react";
import { MediaApiClient } from "../api";
import { ITEMS_PER_PAGE, type LibraryMediaFile, type MediaFilterOptions } from "../types";

const DEFAULT_FILTERS: MediaFilterOptions = {
  search: "",
  sortBy: "createdAt",
  sortOrder: "desc",
  view: "ready",
};

export function useMediaFiles(autoLoad = false) {
  const [files, setFiles] = useState<LibraryMediaFile[]>([]);
  const [isLoading, setIsLoading] = useState(autoLoad);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filters, setFilters] = useState<MediaFilterOptions>(DEFAULT_FILTERS);
  const requestRef = useRef(0);

  const loadFiles = useCallback(async (
    cursor: string | undefined,
    nextFilters: Partial<MediaFilterOptions> = DEFAULT_FILTERS,
  ) => {
    const requestId = ++requestRef.current;
    const merged = { ...DEFAULT_FILTERS, ...nextFilters };
    if (cursor) setIsLoadingMore(true);
    else setIsLoading(true);
    setLoadError(null);
    try {
      const data = await MediaApiClient.fetchFiles(cursor, ITEMS_PER_PAGE, merged);
      if (requestId !== requestRef.current) return;
      setFiles((current) => {
        if (!cursor) return data.files;
        const known = new Set(current.map((file) => file.id));
        return [...current, ...data.files.filter((file) => !known.has(file.id))];
      });
      setNextCursor(data.pagination.nextCursor);
      setHasMore(data.pagination.hasMore);
      setFilters(merged);
      setLoadError(null);
    } catch (error) {
      if (requestId === requestRef.current) {
        setLoadError(error instanceof Error ? error.message : "The media service did not respond.");
      }
    } finally {
      if (requestId === requestRef.current) {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    }
  }, []);

  const applyFilters = useCallback((next: Partial<MediaFilterOptions>) => {
    void loadFiles(undefined, { ...filters, ...next });
  }, [filters, loadFiles]);

  const loadMore = useCallback(() => {
    if (nextCursor && hasMore && !isLoadingMore) void loadFiles(nextCursor, filters);
  }, [filters, hasMore, isLoadingMore, loadFiles, nextCursor]);

  const refresh = useCallback(() => void loadFiles(undefined, filters), [filters, loadFiles]);

  useEffect(() => {
    if (autoLoad) void loadFiles(undefined, DEFAULT_FILTERS);
  }, [autoLoad, loadFiles]);

  return {
    files,
    setFiles,
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
