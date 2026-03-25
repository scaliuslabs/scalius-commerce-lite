/**
 * Shared media manager state and handlers used by both
 * MediaManager (dialog picker) and MediaManagerPage (standalone page).
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { MediaApiClient } from "../api";
import { useMediaFiles, useMediaUpload, useFolders } from ".";
import type { MediaFile } from "../types";

interface UseMediaManagerOptions {
  /** Auto-load files and folders on mount (false for dialog, true for page) */
  autoLoad: boolean;
  /** Folder ID to upload to (derived from currentFolderId) */
  maxFileSize?: number;
  acceptedFileTypes?: string;
  /** Called when selecting a single file (dialog mode) */
  onSelect?: (file: MediaFile) => void;
  /** Called when selecting multiple files (dialog mode) */
  onSelectMultiple?: (files: MediaFile[]) => void;
}

export function useMediaManager({
  autoLoad,
  maxFileSize = 10,
  acceptedFileTypes = "image/*",
  onSelect,
  onSelectMultiple,
}: UseMediaManagerOptions) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewFile, setPreviewFile] = useState<MediaFile | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(null);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [folderSidebarCollapsed, setFolderSidebarCollapsed] = useState(false);

  // Track mount state for safe async updates
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  const {
    files,
    setFiles,
    isLoading,
    isLoadingMore,
    currentPage,
    totalPages,
    filters,
    loadFiles,
    loadMore,
    applyFilters,
    deleteFile,
    deleteFiles: deleteMultipleFiles,
  } = useMediaFiles(false);

  const {
    folders,
    currentFolderId,
    loadFolders,
    createFolder,
    deleteFolder,
    moveToFolder,
  } = useFolders(autoLoad);

  const { isUploading, uploadProgress, currentUploadStatus, uploadFiles } =
    useMediaUpload({
      maxSizeMB: maxFileSize,
      acceptedTypes: acceptedFileTypes,
      folderId: currentFolderId === "all" ? null : currentFolderId,
      onUploadComplete: (uploadedFiles) => {
        const folderParam = toFolderParam(currentFolderId);
        if (autoLoad) {
          applyFilters({ ...filters, folderId: folderParam });
        } else {
          loadFiles(1, { ...filters, folderId: folderParam });
        }

        if (onSelectMultiple && uploadedFiles.length > 0) {
          const newFileIds = uploadedFiles.map((f) => f.id);
          setTimeout(() => {
            if (!mountedRef.current) return;
            setSelectedFileIds(newFileIds);
            setSelectionMode(true);
            toast.success("Upload Complete", { description: "Files uploaded. Click 'Add' to insert them." });
          }, 400);
        } else if (onSelect && uploadedFiles.length > 0) {
          if (uploadedFiles.length === 1) {
            const file = uploadedFiles[0];
            const fileWithDateObject = {
              ...file,
              id: `temp_${file.id}`,
              createdAt: new Date(file.createdAt),
            };
            onSelect(fileWithDateObject);
            toast.success("Image Selected", { description: "Newly uploaded image has been selected." });
          } else {
            toast.success("Upload Complete", { description: "Multiple files uploaded. Click one to select." });
          }
        } else if (uploadedFiles.length > 0) {
          const newFileIds = uploadedFiles.map((f) => f.id);
          setTimeout(() => {
            if (!mountedRef.current) return;
            setSelectedFileIds(newFileIds);
            setSelectionMode(true);
          }, 400);
        }
      },
    });

  // Map folder ID to API param: "all" = no filter, null = "root" (uncategorized), else folder ID
  const toFolderParam = (id: string | null): string =>
    id === "all" ? "all" : id === null ? "root" : id;

  // Load files when folder changes (for page mode)
  useEffect(() => {
    if (autoLoad) {
      applyFilters({ ...filters, folderId: toFolderParam(currentFolderId) });
    }
  }, [currentFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search — use refs to avoid recreating the debounce timer
  // when dependencies change (which would cancel in-flight searches)
  const applyFiltersRef = useRef(applyFilters);
  const currentFolderIdRef = useRef(currentFolderId);
  applyFiltersRef.current = applyFilters;
  currentFolderIdRef.current = currentFolderId;

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedApplyFilters = useCallback(
    (newFilters: typeof filters) => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(() => {
        applyFiltersRef.current({ ...newFilters, folderId: toFolderParam(currentFolderIdRef.current) });
      }, 500);
    },
    [], // stable — reads latest values from refs
  );

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  // Selection handlers
  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId) ? prev.filter((id) => id !== fileId) : [...prev, fileId],
    );
  };

  const toggleSelectionMode = () => {
    if (selectionMode) setSelectedFileIds([]);
    setSelectionMode(!selectionMode);
  };

  const selectAllFiles = () => setSelectedFileIds(files.map((f) => f.id));
  const clearSelection = () => setSelectedFileIds([]);

  // File handlers
  const handleFileSelect = (file: MediaFile) => {
    if (selectionMode) {
      toggleFileSelection(file.id);
    } else if (onSelect) {
      const fileWithDateObject = {
        ...file,
        id: `temp_${file.id}`,
        createdAt: new Date(file.createdAt),
      };
      onSelect(fileWithDateObject);
    }
  };

  const handleFilePreview = (file: MediaFile, e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewFile(file);
    setShowPreview(true);
  };

  const handleDeleteConfirmation = (fileId: string) => {
    setPendingDeleteFileId(fileId);
    setShowDeleteDialog(true);
  };

  const reloadFiles = () => {
    const folderParam = toFolderParam(currentFolderId);
    if (autoLoad) {
      applyFilters({ ...filters, folderId: folderParam });
    } else {
      loadFiles(1, { ...filters, folderId: folderParam });
    }
  };

  const handleFileDelete = async () => {
    if (!pendingDeleteFileId) return;
    await deleteFile(pendingDeleteFileId);
    reloadFiles();
    setPendingDeleteFileId(null);
    setShowDeleteDialog(false);
  };

  const handleBulkDeleteConfirmation = () => {
    if (selectedFileIds.length === 0) return;
    setShowBulkDeleteDialog(true);
  };

  const handleBulkDelete = async () => {
    if (selectedFileIds.length === 0) return;
    await deleteMultipleFiles(selectedFileIds);
    reloadFiles();
    setSelectedFileIds([]);
    setShowBulkDeleteDialog(false);
  };

  const handleMoveToFolder = async (folderId: string | null) => {
    if (selectedFileIds.length === 0) return;
    try {
      const count = selectedFileIds.length;
      await MediaApiClient.moveFilesToFolder(selectedFileIds, folderId);
      const folderName = folderId
        ? folders.find((f) => f.id === folderId)?.name || "folder"
        : "Uncategorized";
      toast.success("Files Moved", {
        description: `Moved ${count} file${count !== 1 ? "s" : ""} to '${folderName}'.`,
      });
      setSelectedFileIds([]);
      setSelectionMode(false);
      // Navigate to the target folder
      moveToFolder(folderId);
    } catch (error: unknown) {
      toast.error("Move Failed", {
        description: (error instanceof Error ? error.message : String(error)) || "Could not move files. Please try again.",
      });
    }
  };

  const handleAltTextUpdate = async (fileId: string, altText: string) => {
    try {
      const updatedFile = await MediaApiClient.updateAltText(fileId, altText);
      const newAltText = updatedFile.altText ?? altText;
      // Update the file in the local list
      setFiles((prev: MediaFile[]) =>
        prev.map((f: MediaFile) => (f.id === fileId ? { ...f, altText: newAltText } : f)),
      );
      // Also update preview file if it's the same one
      if (previewFile && previewFile.id === fileId) {
        setPreviewFile({ ...previewFile, altText: newAltText });
      }
      toast.success("Alt Text Updated", { description: "Alt text has been saved." });
    } catch (error: unknown) {
      toast.error("Update Failed", {
        description: (error instanceof Error ? error.message : String(error)) || "Could not update alt text.",
      });
    }
  };

  const handleAddSelectedFiles = () => {
    if (selectedFileIds.length === 0 || !onSelectMultiple) return;
    const selectedMediaFiles = files.filter((f) => selectedFileIds.includes(f.id));
    const filesWithDateObjects = selectedMediaFiles.map((file) => ({
      ...file,
      id: `temp_${file.id}`,
      createdAt: new Date(file.createdAt),
    }));
    onSelectMultiple(filesWithDateObjects);
  };

  // Preview navigation
  const navigateToNextImage = () => {
    if (!previewFile) return;
    const i = files.findIndex((f) => f.id === previewFile.id);
    if (i < files.length - 1) setPreviewFile(files[i + 1]);
  };

  const navigateToPrevImage = () => {
    if (!previewFile) return;
    const i = files.findIndex((f) => f.id === previewFile.id);
    if (i > 0) setPreviewFile(files[i - 1]);
  };

  return {
    // State
    files,
    isLoading,
    isLoadingMore,
    currentPage,
    totalPages,
    filters,
    folders,
    currentFolderId,
    selectionMode,
    selectedFileIds,
    showPreview,
    previewFile,
    showDeleteDialog,
    pendingDeleteFileId,
    showBulkDeleteDialog,
    folderSidebarCollapsed,
    isUploading,
    uploadProgress,
    currentUploadStatus,

    // Setters
    setSelectionMode,
    setSelectedFileIds,
    setShowPreview,
    setPreviewFile,
    setShowDeleteDialog,
    setPendingDeleteFileId,
    setShowBulkDeleteDialog,
    setFolderSidebarCollapsed,

    // Actions
    loadFiles,
    loadFolders,
    loadMore,
    applyFilters,
    uploadFiles,
    createFolder,
    deleteFolder,
    moveToFolder,
    debouncedApplyFilters,
    toggleFileSelection,
    toggleSelectionMode,
    selectAllFiles,
    clearSelection,
    handleFileSelect,
    handleFilePreview,
    handleDeleteConfirmation,
    handleFileDelete,
    handleBulkDeleteConfirmation,
    handleBulkDelete,
    handleMoveToFolder,
    handleAddSelectedFiles,
    handleAltTextUpdate,
    navigateToNextImage,
    navigateToPrevImage,
  };
}
