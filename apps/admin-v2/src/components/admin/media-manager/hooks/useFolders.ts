import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { mediaText as t } from "~/i18n/media";
import { MediaApiClient } from "../api";
import type { MediaFolder } from "../types";

export function useFolders(autoLoad = false) {
  const [folders, setFolders] = useState<MediaFolder[]>([]);
  const [isLoading, setIsLoading] = useState(autoLoad);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | null | "all">("all");

  const loadFolders = useCallback(async () => {
    setIsLoading(true);
    try {
      setFolders(await MediaApiClient.fetchFolders());
      setLoadError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : t("tryAgain");
      setLoadError(message);
      toast.error(t("foldersLoadFailed"), { description: message });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createFolder = useCallback(async (name: string) => {
    try {
      const folder = await MediaApiClient.createFolder(name);
      setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
      toast.success(t("folderCreated"));
      return folder;
    } catch (error) {
      toast.error(t("folderCreateFailed"), { description: error instanceof Error ? error.message : undefined });
      throw error;
    }
  }, []);

  const renameFolder = useCallback(async (folder: MediaFolder, name: string) => {
    try {
      const updated = await MediaApiClient.renameFolder(folder, name);
      setFolders((current) => current.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.name.localeCompare(b.name)));
      toast.success(t("folderRenamed"));
    } catch (error) {
      toast.error(t("folderRenameFailed"), { description: error instanceof Error ? error.message : undefined });
      throw error;
    }
  }, []);

  const deleteFolder = useCallback(async (folder: MediaFolder) => {
    try {
      await MediaApiClient.deleteFolder(folder);
      setFolders((current) => current.filter((item) => item.id !== folder.id));
      setCurrentFolderId((current) => current === folder.id ? "all" : current);
      toast.success(t("folderDeleted"));
      return true;
    } catch (error) {
      toast.error(t("folderDeleteFailed"), { description: error instanceof Error ? error.message : t("folderNotEmpty") });
      return false;
    }
  }, []);

  useEffect(() => { if (autoLoad) void loadFolders(); }, [autoLoad, loadFolders]);

  return {
    folders,
    isLoadingFolders: isLoading,
    folderLoadError: loadError,
    currentFolderId,
    loadFolders,
    createFolder,
    renameFolder,
    deleteFolder,
    moveToFolder: setCurrentFolderId,
  };
}
