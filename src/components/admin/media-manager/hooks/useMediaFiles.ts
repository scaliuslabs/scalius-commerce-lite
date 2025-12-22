// Hook for managing media files state with proper loading states and race condition prevention

import { useState, useCallback, useEffect, useRef } from "react";
import { MediaApiClient } from "../api";
import type { MediaFile, MediaFilterOptions } from "../types";
import { toast } from "@/hooks/use-toast";

export function useMediaFiles(autoLoad: boolean = false) {
  const [files, setFiles] = useState<MediaFile[]>([]);
  // Start with loading=true if autoLoad is enabled to prevent "No files" flicker
  const [isLoading, setIsLoading] = useState(autoLoad);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [filters, setFilters] = useState<Partial<MediaFilterOptions>>({});

  // Track the current request to prevent race conditions
  const currentRequestId = useRef(0);
  const isInitialLoad = useRef(true);

  const loadFiles = useCallback(
    async (page: number = 1, newFilters: Partial<MediaFilterOptions> = {}) => {
      // Generate a unique ID for this request
      const requestId = ++currentRequestId.current;

      // Only show loading for first page loads
      if (page === 1) {
        setIsLoading(true);
        // Don't clear files immediately - keep them until new ones load
        // This prevents the "no files" flicker
      } else {
        setIsLoadingMore(true);
      }

      try {
        // Reduced from 20 to 12 for better performance with large images
        const data = await MediaApiClient.fetchFiles(page, 12, newFilters);

        // Only update state if this is still the current request
        // This prevents race conditions when rapidly switching folders
        if (requestId === currentRequestId.current) {
          // Smooth transition: only update files after data loads
          setFiles((prevFiles) =>
            page === 1 ? data.files : [...prevFiles, ...data.files],
          );
          setCurrentPage(data.pagination.page);
          setTotalPages(data.pagination.totalPages);
          setFilters(newFilters);
          isInitialLoad.current = false;
        } else {
          // Request was superseded, ignore results
          console.log(`Ignored outdated request ${requestId}, current is ${currentRequestId.current}`);
        }
      } catch (error: any) {
        // Only show error for current request
        if (requestId === currentRequestId.current) {
          console.error("Error loading files:", error);

          // Don't show error toast on initial load (user hasn't interacted yet)
          if (!isInitialLoad.current) {
            toast({
              title: "Error Loading Files",
              description: error.message || "Could not load media files. Please try again.",
              variant: "destructive",
            });
          }
        }
      } finally {
        // Only update loading state if this is still the current request
        if (requestId === currentRequestId.current) {
          setIsLoading(false);
          setIsLoadingMore(false);
        }
      }
    },
    [],
  );

  const loadMore = useCallback(() => {
    if (currentPage < totalPages && !isLoadingMore && !isLoading) {
      loadFiles(currentPage + 1, filters);
    }
  }, [currentPage, totalPages, isLoadingMore, isLoading, filters, loadFiles]);

  const applyFilters = useCallback(
    (newFilters: Partial<MediaFilterOptions>) => {
      setFilters(newFilters);
      setCurrentPage(1);
      loadFiles(1, newFilters);
    },
    [loadFiles],
  );

  const refresh = useCallback(() => {
    // Always reload from page 1 to ensure we see newly uploaded files
    loadFiles(1, filters);
  }, [filters, loadFiles]);

  const deleteFile = useCallback(
    async (fileId: string) => {
      const filesBeforeDelete = [...files];

      try {
        // Optimistically update UI
        setFiles((prevFiles) => prevFiles.filter((f) => f.id !== fileId));

        await MediaApiClient.deleteFile(fileId);

        toast({
          title: "File Deleted",
          description: "The file has been successfully deleted.",
        });

        // Don't reload - optimistic update is enough
        // This prevents unnecessary flicker
      } catch (error: any) {
        console.error("Error deleting file:", error);
        // Revert UI on error
        setFiles(filesBeforeDelete);
        toast({
          title: "Deletion Failed",
          description:
            error.message || "Could not delete the file. Please try again.",
          variant: "destructive",
        });
      }
    },
    [files],
  );

  const deleteFiles = useCallback(
    async (fileIds: string[]) => {
      const filesBeforeDelete = [...files];

      try {
        // Optimistically update UI
        setFiles((prevFiles) =>
          prevFiles.filter((file) => !fileIds.includes(file.id)),
        );

        const result = await MediaApiClient.deleteFiles(fileIds);

        if (result.failed === 0) {
          toast({
            title: "Bulk Deletion Successful",
            description: `Successfully deleted ${result.success} file${result.success !== 1 ? "s" : ""}.`,
          });
        } else if (result.success === 0) {
          setFiles(filesBeforeDelete);
          toast({
            title: "Bulk Deletion Failed",
            description: `Failed to delete ${result.failed} file${result.failed !== 1 ? "s" : ""}.`,
            variant: "destructive",
          });
        } else {
          toast({
            title: "Partial Bulk Deletion",
            description: `Deleted ${result.success}, failed ${result.failed} file${result.failed !== 1 ? "s" : ""}.`,
            variant: "destructive",
          });
        }
      } catch (error: any) {
        console.error("Error deleting files:", error);
        setFiles(filesBeforeDelete);
        toast({
          title: "Deletion Failed",
          description:
            error.message || "Could not delete files. Please try again.",
          variant: "destructive",
        });
      }
    },
    [files],
  );

  // Auto-load on mount if enabled
  useEffect(() => {
    if (autoLoad) {
      loadFiles(1, {});
    }
  }, [autoLoad]); // Only run on mount, not when loadFiles changes

  return {
    files,
    isLoading,
    isLoadingMore,
    currentPage,
    totalPages,
    filters,
    loadFiles,
    loadMore,
    applyFilters,
    refresh,
    deleteFile,
    deleteFiles,
  };
}
