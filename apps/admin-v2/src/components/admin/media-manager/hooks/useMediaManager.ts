import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { MediaApiClient } from "../api";
import { useFolders, useMediaFiles, useMediaUpload } from ".";
import { capabilityKind, type LibraryMediaFile, type MediaCapability, type MediaFile, type MediaLibraryView } from "../types";

interface UseMediaManagerOptions {
  autoLoad: boolean;
  capability: MediaCapability;
  onSelect?: (file: MediaFile) => void;
  onSelectMultiple?: (files: MediaFile[]) => void;
}

function folderFilter(folderId: string | null | "all"): string | null | undefined {
  return folderId === "all" ? undefined : folderId;
}

async function bounded<T>(values: T[], task: (value: T) => Promise<void>, concurrency = 3) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const value = values[cursor++];
      await task(value);
    }
  });
  await Promise.all(workers);
}

export function useMediaManager({ autoLoad, capability, onSelect, onSelectMultiple }: UseMediaManagerOptions) {
  const media = useMediaFiles(false);
  const folders = useFolders(autoLoad);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [previewFile, setPreviewFile] = useState<LibraryMediaFile | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [view, setViewState] = useState<MediaLibraryView>("ready");
  const [isMutating, setIsMutating] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const upload = useMediaUpload({
    capability,
    folderId: folders.currentFolderId === "all" ? null : folders.currentFolderId,
    onUploadComplete: (uploaded) => {
      setSelectedFileIds((current) => [...new Set([...current, ...uploaded.map((file) => file.id)])]);
      if (onSelectMultiple) setSelectionMode(true);
      if (uploadRefreshTimer.current) clearTimeout(uploadRefreshTimer.current);
      uploadRefreshTimer.current = setTimeout(() => void media.refresh(), 350);
    },
  });

  const baseFilters = useMemo(() => ({
    kind: capabilityKind(capability),
    folderId: folderFilter(folders.currentFolderId),
    view,
  }), [capability, folders.currentFolderId, view]);

  useEffect(() => {
    setSelectedFileIds([]);
    setSelectionMode(false);
    if (autoLoad) void media.loadFiles(undefined, { ...media.filters, ...baseFilters });
    // Filters are deliberately reset by these navigation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoad, capability, folders.currentFolderId, view]);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (uploadRefreshTimer.current) clearTimeout(uploadRefreshTimer.current);
  }, []);

  const load = useCallback(() => media.loadFiles(undefined, { ...media.filters, ...baseFilters }), [baseFilters, media]);

  const applyFilters = useCallback((updates: Partial<typeof media.filters>) => {
    setSelectedFileIds([]);
    setSelectionMode(false);
    void media.loadFiles(undefined, { ...media.filters, ...baseFilters, ...updates });
  }, [baseFilters, media]);

  const applySearch = useCallback((search: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => applyFilters({ search }), 300);
  }, [applyFilters]);

  const setView = useCallback((next: MediaLibraryView) => {
    setViewState(next);
    setSelectedFileIds([]);
    setSelectionMode(false);
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedFileIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }, []);

  const handleFileSelect = useCallback((file: LibraryMediaFile) => {
    if (selectionMode || onSelectMultiple) {
      setSelectionMode(true);
      toggleSelection(file.id);
      return;
    }
    if (onSelect) onSelect(file);
    else {
      setPreviewFile(file);
      setShowPreview(true);
    }
  }, [onSelect, onSelectMultiple, selectionMode, toggleSelection]);

  const selectedFiles = media.files.filter((file) => selectedFileIds.includes(file.id));

  const mutateOne = useCallback(async (file: LibraryMediaFile, action: "trash" | "restore" | "permanent") => {
    setIsMutating(true);
    try {
      if (action === "trash") await MediaApiClient.trashFile(file);
      else if (action === "restore") await MediaApiClient.restoreFile(file);
      else await MediaApiClient.permanentlyDeleteFile(file);
      toast.success(action === "trash" ? "Moved to trash" : action === "restore" ? "Restored" : "Permanently deleted");
      await load();
    } catch (error) {
      toast.error("Media was not changed", { description: error instanceof Error ? error.message : "Refresh and try again." });
    } finally {
      setIsMutating(false);
    }
  }, [load]);

  const mutateSelected = useCallback(async (action: "trash" | "restore" | "permanent") => {
    if (!selectedFiles.length) return;
    setIsMutating(true);
    let succeeded = 0;
    const failures: string[] = [];
    await bounded(selectedFiles, async (file) => {
      try {
        if (action === "trash") await MediaApiClient.trashFile(file);
        else if (action === "restore") await MediaApiClient.restoreFile(file);
        else await MediaApiClient.permanentlyDeleteFile(file);
        succeeded += 1;
      } catch (error) {
        failures.push(`${file.filename}: ${error instanceof Error ? error.message : "failed"}`);
      }
    });
    setIsMutating(false);
    setSelectedFileIds([]);
    await load();
    if (succeeded) toast.success(`${succeeded} asset${succeeded === 1 ? "" : "s"} updated`);
    if (failures.length) toast.error(`${failures.length} asset${failures.length === 1 ? "" : "s"} not changed`, { description: failures.slice(0, 3).join("\n") });
  }, [load, selectedFiles]);

  const moveSelected = useCallback(async (folderId: string | null) => {
    if (!selectedFiles.length) return;
    setIsMutating(true);
    try {
      await MediaApiClient.moveFiles(selectedFiles, folderId);
      setSelectedFileIds([]);
      toast.success("Assets moved");
      await load();
    } catch (error) {
      toast.error("Assets were not moved", { description: error instanceof Error ? error.message : "Refresh and try again." });
    } finally {
      setIsMutating(false);
    }
  }, [load, selectedFiles]);

  const updateFile = useCallback(async (file: LibraryMediaFile, updates: Parameters<typeof MediaApiClient.updateFile>[1]) => {
    try {
      const updated = await MediaApiClient.updateFile(file, updates);
      media.setFiles((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPreviewFile((current) => current?.id === updated.id ? updated : current);
      toast.success("Details saved");
      return updated;
    } catch (error) {
      toast.error("Details were not saved", { description: error instanceof Error ? error.message : "Refresh and try again." });
      throw error;
    }
  }, [media]);

  const addSelected = useCallback(() => {
    if (!onSelectMultiple || !selectedFiles.length) return;
    onSelectMultiple(selectedFiles);
  }, [onSelectMultiple, selectedFiles]);

  return {
    ...media,
    ...folders,
    ...upload,
    view,
    setView,
    selectedFileIds,
    setSelectedFileIds,
    selectionMode,
    setSelectionMode,
    selectedFiles,
    previewFile,
    setPreviewFile,
    showPreview,
    setShowPreview,
    isMutating,
    load,
    applyFilters,
    applySearch,
    toggleSelection,
    handleFileSelect,
    mutateOne,
    mutateSelected,
    moveSelected,
    updateFile,
    addSelected,
  };
}
