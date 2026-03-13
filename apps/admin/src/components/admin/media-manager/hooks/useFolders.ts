// Hook for managing folders

import { useState, useCallback, useEffect } from "react";
import { MediaApiClient } from "../api";
import type { MediaFolder } from "../types";
import { toast } from "@/hooks/use-toast";

export function useFolders(autoLoad: boolean = false) {
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>("all"); // "all" shows all files from all folders

  const loadFolders = useCallback(async () => {
    setIsLoading(true);
    try {
      const loadedFolders = await MediaApiClient.fetchFolders();
      setFolders(loadedFolders);
    } catch (error) {
      console.error("Error loading folders:", error);
      toast({
        title: "Error Loading Folders",
        description: "Could not load folders. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createFolder = useCallback(
    async (name: string, parentId?: string | null) => {
      try {
        const newFolder = await MediaApiClient.createFolder(name, parentId);
        setFolders((prev) => [...prev, newFolder]);

        toast({
          title: "Folder Created",
          description: `Successfully created folder "${name}".`,
        });

        return newFolder;
      } catch (error: any) {
        console.error("Error creating folder:", error);
        toast({
          title: "Folder Creation Failed",
          description:
            error.message || "Could not create folder. Please try again.",
          variant: "destructive",
        });
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

        toast({
          title: "Folder Deleted",
          description: "The folder has been successfully deleted.",
        });
      } catch (error: any) {
        console.error("Error deleting folder:", error);
        toast({
          title: "Deletion Failed",
          description:
            error.message || "Could not delete folder. Please try again.",
          variant: "destructive",
        });
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
