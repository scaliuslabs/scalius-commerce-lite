import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { mediaText as t } from "~/i18n/media";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { MediaApiClient } from "../api";
import { useFolders, useMediaFiles, useMediaUpload } from ".";
import {
  canDeletePermanently,
  capabilityKind,
  type LibraryMediaFile,
  type MediaCapability,
  type MediaFile,
  type MediaLibraryView,
  type MediaWorkspaceRouteState,
  type MediaWorkspaceRouteUpdateOptions,
} from "../types";
import { resolveSelectedMedia, selectAllVisibleMedia, updateMediaSelection } from "../utils/selection";
import { mergeUploadedFiles } from "../utils/uploaded-files";

interface UseMediaManagerOptions {
  autoLoad: boolean;
  capability: MediaCapability;
  initialSelectedFiles?: MediaFile[];
  unavailableFileIds?: string[];
  onSelect?: (file: MediaFile) => void;
  onSelectMultiple?: (files: MediaFile[]) => void;
  workspaceState?: MediaWorkspaceRouteState;
  onWorkspaceStateChange?: (
    updates: Partial<MediaWorkspaceRouteState>,
    options?: MediaWorkspaceRouteUpdateOptions,
  ) => void;
}

const EMPTY_FILE_IDS: string[] = [];
const UNDO_MS = 10_000;

type MediaLifecycle = "trash" | "restore" | "permanent";

/** Plain catalog text for a refused change; server wording is never shown. */
function failureText(error: unknown): string | undefined {
  if (!(error instanceof AdminApiResponseError)) return undefined;
  if (error.code === "MEDIA_DEPENDENCY_CONFLICT") return t("stillUsed");
  if (error.status === 409) return t("changedElsewhere");
  return undefined;
}

function describeFailure(file: LibraryMediaFile, error: unknown): string {
  const text = failureText(error);
  return text ? `${file.filename}: ${text}` : file.filename;
}

/** Trash and restore return the new version; permanent delete returns nothing. */
async function applyLifecycle(file: LibraryMediaFile, action: MediaLifecycle): Promise<LibraryMediaFile | null> {
  if (action === "trash") return MediaApiClient.trashFile(file);
  if (action === "restore") return MediaApiClient.restoreFile(file);
  await MediaApiClient.permanentlyDeleteFile(file);
  return null;
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

export function useMediaManager({
  autoLoad,
  capability,
  initialSelectedFiles = [],
  unavailableFileIds = EMPTY_FILE_IDS,
  onSelect,
  onSelectMultiple,
  workspaceState,
  onWorkspaceStateChange,
}: UseMediaManagerOptions) {
  const media = useMediaFiles(false);
  const folders = useFolders(autoLoad);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [selectionMode, setSelectionMode] = useState(!!onSelectMultiple);
  const [previewFile, setPreviewFile] = useState<LibraryMediaFile | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [viewState, setViewState] = useState<MediaLibraryView>("ready");
  const [isMutating, setIsMutating] = useState(false);
  // Finished upload rows leave the queue; their files stay resolvable for selection.
  const [uploadedFiles, setUploadedFiles] = useState<LibraryMediaFile[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionAnchorId = useRef<string | null>(null);
  const unavailableFileIdSet = useMemo(
    () => new Set(unavailableFileIds.map((id) => id.replace(/^temp_/, ""))),
    [unavailableFileIds],
  );
  const isFileUnavailable = useCallback(
    (id: string) => unavailableFileIdSet.has(id.replace(/^temp_/, "")),
    [unavailableFileIdSet],
  );
  const routeControlled = workspaceState !== undefined && onWorkspaceStateChange !== undefined;
  const view = routeControlled ? workspaceState.view : viewState;
  const currentFolderId = routeControlled ? workspaceState.folderId : folders.currentFolderId;

  const baseFilters = useMemo(() => ({
    kind: capabilityKind(capability),
    folderId: folderFilter(currentFolderId),
    view,
  }), [capability, currentFolderId, view]);

  const filters = useMemo(() => {
    if (!routeControlled || !workspaceState) return media.filters;
    return {
      search: workspaceState.search,
      sortBy: workspaceState.sortBy,
      sortOrder: workspaceState.sortOrder,
      kind: capabilityKind(capability) ?? workspaceState.kind,
      folderId: folderFilter(workspaceState.folderId),
      view: workspaceState.view,
    };
  }, [capability, media.filters, routeControlled, workspaceState]);
  const activeFiltersRef = useRef(filters);
  activeFiltersRef.current = filters;

  const upload = useMediaUpload({
    capability,
    folderId: currentFolderId === "all" ? null : currentFolderId,
    onUploadComplete: (uploaded) => {
      setUploadedFiles((current) => [...uploaded, ...current]);
      if (onSelectMultiple) {
        setSelectedFileIds((current) => [...new Set([...current, ...uploaded.map((file) => file.id)])]);
        setSelectionMode(true);
      }

      const activeFilters = activeFiltersRef.current;
      media.setFiles((current) => mergeUploadedFiles(current, uploaded, activeFilters));
      void media.loadFiles(undefined, activeFilters);
    },
  });

  useEffect(() => {
    setSelectedFileIds([]);
    setSelectionMode(!!onSelectMultiple);
    selectionAnchorId.current = null;
    if (autoLoad) {
      void media.loadFiles(undefined, routeControlled
        ? filters
        : { ...media.filters, ...baseFilters });
    }
    // Filters are deliberately reset by these navigation changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoLoad,
    capability,
    currentFolderId,
    routeControlled,
    view,
    workspaceState?.kind,
    workspaceState?.search,
    workspaceState?.sortBy,
    workspaceState?.sortOrder,
  ]);

  useEffect(() => {
    if (
      !routeControlled
      || folders.isLoadingFolders
      || folders.folderLoadError
      || typeof currentFolderId !== "string"
      || currentFolderId === "all"
      || folders.folders.some((folder) => folder.id === currentFolderId)
    ) return;

    onWorkspaceStateChange?.({ folderId: "all" }, { replace: true });
  }, [
    currentFolderId,
    folders.folders,
    folders.folderLoadError,
    folders.isLoadingFolders,
    onWorkspaceStateChange,
    routeControlled,
  ]);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const load = useCallback(
    () => media.loadFiles(undefined, routeControlled ? filters : { ...media.filters, ...baseFilters }),
    [baseFilters, filters, media, routeControlled],
  );

  const applyFilters = useCallback((updates: Partial<typeof media.filters>) => {
    setSelectedFileIds([]);
    setSelectionMode(!!onSelectMultiple);
    selectionAnchorId.current = null;
    if (routeControlled) {
      onWorkspaceStateChange?.({
        ...(Object.prototype.hasOwnProperty.call(updates, "kind") ? { kind: updates.kind } : {}),
        ...(updates.sortBy ? { sortBy: updates.sortBy } : {}),
        ...(updates.sortOrder ? { sortOrder: updates.sortOrder } : {}),
      });
      return;
    }
    void media.loadFiles(undefined, { ...media.filters, ...baseFilters, ...updates });
  }, [baseFilters, media, onSelectMultiple, onWorkspaceStateChange, routeControlled]);

  const applySearch = useCallback((search: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      if (routeControlled) {
        setSelectedFileIds([]);
        setSelectionMode(!!onSelectMultiple);
        selectionAnchorId.current = null;
        onWorkspaceStateChange?.({ search }, { replace: true });
      } else {
        applyFilters({ search });
      }
    }, 300);
  }, [applyFilters, onSelectMultiple, onWorkspaceStateChange, routeControlled]);

  const setView = useCallback((next: MediaLibraryView) => {
    setSelectedFileIds([]);
    setSelectionMode(!!onSelectMultiple);
    selectionAnchorId.current = null;
    if (routeControlled) onWorkspaceStateChange?.({ view: next });
    else setViewState(next);
  }, [onSelectMultiple, onWorkspaceStateChange, routeControlled]);

  const moveToFolder = useCallback((folderId: string | null | "all") => {
    if (routeControlled) onWorkspaceStateChange?.({ folderId });
    else folders.moveToFolder(folderId);
  }, [folders, onWorkspaceStateChange, routeControlled]);

  const deleteFolder = useCallback(async (folder: typeof folders.folders[number]) => {
    const deleted = await folders.deleteFolder(folder);
    if (deleted && routeControlled && currentFolderId === folder.id) {
      onWorkspaceStateChange?.({ folderId: "all" }, { replace: true });
    }
  }, [currentFolderId, folders, onWorkspaceStateChange, routeControlled]);

  /** Clears search, type and folder in one step (one route write). */
  const clearFilters = useCallback(() => {
    setSelectedFileIds([]);
    setSelectionMode(!!onSelectMultiple);
    selectionAnchorId.current = null;
    if (routeControlled) {
      onWorkspaceStateChange?.({ search: "", kind: undefined, folderId: "all" });
      return;
    }
    folders.moveToFolder("all");
    void media.loadFiles(undefined, { ...media.filters, ...baseFilters, search: "", folderId: undefined });
  }, [baseFilters, folders, media, onSelectMultiple, onWorkspaceStateChange, routeControlled]);

  const replaceSelection = useCallback((ids: string[]) => {
    selectionAnchorId.current = null;
    setSelectedFileIds([...new Set(ids.filter((id) => !isFileUnavailable(id)))]);
  }, [isFileUnavailable]);

  const beginSelection = useCallback(() => {
    selectionAnchorId.current = null;
    setSelectedFileIds([]);
    setSelectionMode(true);
  }, []);

  const selectAllVisible = useCallback(() => {
    const visibleIds = media.files
      .map((file) => file.id)
      .filter((id) => !isFileUnavailable(id));
    selectionAnchorId.current = visibleIds[0] ?? null;
    setSelectedFileIds(selectAllVisibleMedia(visibleIds));
  }, [media.files, isFileUnavailable]);

  const clearSelection = useCallback((preserveMode: boolean) => {
    selectionAnchorId.current = null;
    setSelectedFileIds([]);
    setSelectionMode(preserveMode);
  }, []);

  const cancelSelection = useCallback(() => {
    selectionAnchorId.current = null;
    setSelectedFileIds([]);
    setSelectionMode(false);
  }, []);

  const toggleSelection = useCallback((id: string, extendRange = false) => {
    if (isFileUnavailable(id)) return;
    setSelectedFileIds((current) => {
      const update = updateMediaSelection({
        selectedIds: current,
        visibleIds: media.files.map((file) => file.id),
        targetId: id,
        anchorId: selectionAnchorId.current,
        extendRange,
      });
      selectionAnchorId.current = update.anchorId;
      return update.selectedIds;
    });
  }, [media.files, isFileUnavailable]);

  const handleFileSelect = useCallback((file: LibraryMediaFile, extendRange = false) => {
    if (isFileUnavailable(file.id)) return;
    if (selectionMode || onSelectMultiple) {
      setSelectionMode(true);
      toggleSelection(file.id, extendRange);
      return;
    }
    if (onSelect) onSelect(file);
    else {
      setPreviewFile(file);
      setShowPreview(true);
    }
  }, [onSelect, onSelectMultiple, selectionMode, toggleSelection, isFileUnavailable]);

  const selectableFileCount = useMemo(
    () => media.files.filter((file) => !isFileUnavailable(file.id)).length,
    [isFileUnavailable, media.files],
  );

  const initialSelectionSource = initialSelectedFiles.map((file) => ({
    ...file,
    id: file.id.replace(/^temp_/, ""),
  }));
  const selectedFiles = resolveSelectedMedia<MediaFile>(
    selectedFileIds,
    media.files,
    uploadedFiles,
    initialSelectionSource,
  );
  const selectedLibraryFiles = resolveSelectedMedia<LibraryMediaFile>(
    selectedFileIds,
    media.files,
    uploadedFiles,
  );

  /** Restores files a moment after they were trashed (the toast's Undo). */
  const restoreTrashed = useCallback(async (files: LibraryMediaFile[]) => {
    let restored = 0;
    const failures: string[] = [];
    await bounded(files, async (file) => {
      try {
        await MediaApiClient.restoreFile(file);
        restored += 1;
      } catch (error) {
        failures.push(describeFailure(file, error));
      }
    });
    await load();
    if (restored) toast.success(restored === 1 ? t("fileRestored") : t("filesRestored", { count: restored }));
    if (failures.length) {
      toast.error(failures.length === 1 ? t("notChangedOne") : t("notChangedMany", { count: failures.length }), { description: failures.slice(0, 3).join("\n") });
    }
  }, [load]);

  const confirmTrashed = useCallback((trashed: LibraryMediaFile[]) => {
    toast.success(trashed.length === 1 ? t("fileTrashed") : t("filesTrashed", { count: trashed.length }), {
      duration: UNDO_MS,
      action: { label: t("undo"), onClick: () => void restoreTrashed(trashed) },
    });
  }, [restoreTrashed]);

  const mutateOne = useCallback(async (file: LibraryMediaFile, action: MediaLifecycle) => {
    setIsMutating(true);
    try {
      const changed = await applyLifecycle(file, action);
      setSelectedFileIds((current) => current.filter((id) => id !== file.id));
      if (selectionAnchorId.current === file.id) selectionAnchorId.current = null;
      if (action === "trash" && changed) confirmTrashed([changed]);
      else toast.success(t(action === "restore" ? "fileRestored" : "fileDeleted"));
      await load();
    } catch (error) {
      toast.error(t("changeFailed"), { description: failureText(error) });
    } finally {
      setIsMutating(false);
    }
  }, [confirmTrashed, load]);

  const mutateSelected = useCallback(async (action: MediaLifecycle) => {
    if (!selectedLibraryFiles.length) return;
    // Files still in use never reach the permanent-delete call; they stay in Trash.
    const kept = action === "permanent" ? selectedLibraryFiles.filter((file) => !canDeletePermanently(file)) : [];
    const targets = action === "permanent" ? selectedLibraryFiles.filter(canDeletePermanently) : selectedLibraryFiles;
    setIsMutating(true);
    const changed: LibraryMediaFile[] = [];
    const failures: string[] = [];
    const failedIds: string[] = [];
    await bounded(targets, async (file) => {
      try {
        changed.push((await applyLifecycle(file, action)) ?? file);
      } catch (error) {
        failedIds.push(file.id);
        failures.push(describeFailure(file, error));
      }
    });
    setSelectedFileIds([...failedIds, ...kept.map((file) => file.id)]);
    selectionAnchorId.current = null;
    await load();
    setIsMutating(false);
    if (action === "trash" && changed.length) confirmTrashed(changed);
    else if (changed.length) {
      const restore = action === "restore";
      toast.success(changed.length === 1
        ? t(restore ? "fileRestored" : "fileDeleted")
        : t(restore ? "filesRestored" : "filesDeleted", { count: changed.length }));
    }
    if (kept.length) toast.info(kept.length === 1 ? t("deleteSkippedOne") : t("deleteSkipped", { count: kept.length }));
    if (failures.length) {
      toast.error(failures.length === 1 ? t("notChangedOne") : t("notChangedMany", { count: failures.length }), { description: failures.slice(0, 3).join("\n") });
    }
  }, [confirmTrashed, load, selectedLibraryFiles]);

  const moveSelected = useCallback(async (folderId: string | null) => {
    if (!selectedLibraryFiles.length) return;
    setIsMutating(true);
    try {
      await MediaApiClient.moveFiles(selectedLibraryFiles, folderId);
      setSelectedFileIds([]);
      selectionAnchorId.current = null;
      toast.success(t("filesMoved"));
      await load();
    } catch (error) {
      toast.error(t("moveFailed"), { description: failureText(error) });
    } finally {
      setIsMutating(false);
    }
  }, [load, selectedLibraryFiles]);

  const updateFile = useCallback(async (file: LibraryMediaFile, updates: Parameters<typeof MediaApiClient.updateFile>[1]) => {
    try {
      const updated = await MediaApiClient.updateFile(file, updates);
      media.setFiles((current) => current.map((item) => item.id === updated.id ? updated : item));
      setPreviewFile((current) => current?.id === updated.id ? updated : current);
      toast.success(t("fileSaved"));
      return updated;
    } catch (error) {
      toast.error(t("saveFailed"), { description: failureText(error) });
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
    filters,
    view,
    setView,
    currentFolderId,
    moveToFolder,
    deleteFolder,
    clearFilters,
    selectedFileIds,
    selectableFileCount,
    isFileUnavailable,
    replaceSelection,
    selectionMode,
    setSelectionMode,
    selectedFiles,
    selectedLibraryFiles,
    previewFile,
    setPreviewFile,
    showPreview,
    setShowPreview,
    isMutating,
    load,
    applyFilters,
    applySearch,
    beginSelection,
    selectAllVisible,
    clearSelection,
    cancelSelection,
    toggleSelection,
    handleFileSelect,
    mutateOne,
    mutateSelected,
    moveSelected,
    updateFile,
    addSelected,
  };
}
