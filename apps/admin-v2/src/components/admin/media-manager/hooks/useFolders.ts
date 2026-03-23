// Hook for managing folders

import { useState, useCallback, useEffect } from "react";
import { MediaApiClient } from "../api";
import type { MediaFolder } from "../types";
import { toast } from "sonner";

export function useFolders(autoLoad: boolean = false) {
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>("all"); // "all" shows all files from all folders

  const loadFolders = useCallback(async () => {
    setIsLoading(true);
    try {
      const loadedFolders = await MediaApiClient.fetchFolders();
      setFolders(loadedFolders);
    } catch (error: unknown) {
      console.error("Error loading folders:", error);
      toast.error("Error Loading Folders", { description: "Could not load folders. Please try again." });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createFolder = useCallback(
    async (name: string, parentId?: string | null) => {
      try {
        const newFolder = await MediaApiClient.createFolder(name, parentId);
        setFolders((prev) => [...prev, newFolder]);

        toast.success("Folder Created", { description: `Successfully created folder "${name}".` });

        return newFolder;
      } catch (error: unknown) {
        console.error("Error creating folder:", error);
        toast.error("Folder Creation Failed", { description: (error instanceof Error ? error.message : String(error)) || "Could not create folder. Please try again." });
        throw error;
      }
    },
    [],
  );

  const deleteFolder = useCallback(
    async (folderId: string) => {
      try {
        await MediaApiClient.deleteFolder(folderId);
        setFolders((prev) => prev.filter((f) => f.id !== folderId));

        // If we deleted the current folder, reset to root
        if (currentFolderId === folderId) {
          setCurrentFolderId(null);
        }

        toast.success("Folder Deleted", { description: "The folder has been successfully deleted." });
      } catch (error: unknown) {
        console.error("Error deleting folder:", error);
        toast.error("Deletion Failed", { description: (error instanceof Error ? error.message : String(error)) || "Could not delete folder. Please try again." });
        throw error;
      }
    },
    [currentFolderId],
  );

  const moveToFolder = useCallback((folderId: string | null) => {
    setCurrentFolderId(folderId);
  }, []);

  // Auto-load on mount if enabled
  useEffect(() => {
    if (autoLoad) {
      loadFolders();
    }
  }, [autoLoad, loadFolders]);

  return {
    folders,
    isLoading,
    currentFolderId,
    loadFolders,
    createFolder,
    deleteFolder,
    moveToFolder,
  };
}
