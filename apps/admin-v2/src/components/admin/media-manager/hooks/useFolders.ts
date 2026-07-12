import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { MediaApiClient } from "../api";
import type { MediaFolder } from "../types";

export function useFolders(autoLoad = false) {
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [isLoading, setIsLoading] = useState(autoLoad);
  const [currentFolderId, setCurrentFolderId] = useState<string | null | "all">("all");

  const loadFolders = useCallback(async () => {
    setIsLoading(true);
    try {
      setFolders(await MediaApiClient.fetchFolders());
    } catch (error) {
      toast.error("Folders could not be loaded", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createFolder = useCallback(async (name: string) => {
    const folder = await MediaApiClient.createFolder(name);
    setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
    toast.success("Folder created");
    return folder;
  }, []);

  const renameFolder = useCallback(async (folder: MediaFolder, name: string) => {
    try {
      const updated = await MediaApiClient.renameFolder(folder, name);
      setFolders((current) => current.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.name.localeCompare(b.name)));
      toast.success("Folder renamed");
    } catch (error) {
      toast.error("Folder was not renamed", { description: error instanceof Error ? error.message : "Refresh and try again." });
    }
  }, []);

  const deleteFolder = useCallback(async (folder: MediaFolder) => {
    try {
      await MediaApiClient.deleteFolder(folder);
      setFolders((current) => current.filter((item) => item.id !== folder.id));
      setCurrentFolderId((current) => current === folder.id ? "all" : current);
      toast.success("Folder deleted");
    } catch (error) {
      toast.error("Folder was not deleted", { description: error instanceof Error ? error.message : "Move its assets, refresh, and try again." });
    }
  }, []);

  useEffect(() => { if (autoLoad) void loadFolders(); }, [autoLoad, loadFolders]);

  return {
    folders,
    isLoading,
    currentFolderId,
    loadFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveToFolder: setCurrentFolderId,
  };
}
