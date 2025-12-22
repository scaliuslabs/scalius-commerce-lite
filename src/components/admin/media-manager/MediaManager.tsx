// Main MediaManager component (Dialog version for selecting media)

import React, { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import {
  MediaGallery,
  MediaPreview,
  MediaFilterBar,
  FolderBrowser,
} from "./components";
import { useMediaFiles, useMediaUpload, useFolders } from "./hooks";
import { debounce } from "./utils";
import { MediaApiClient } from "./api";
import type { MediaFile, MediaManagerProps } from "./types";
import { toast } from "@/hooks/use-toast";

export function MediaManager({
  onSelect,
  onSelectMultiple,
  triggerLabel = "Select Image",
  acceptedFileTypes = "image/*",
  maxFileSize = 10,
  dialogClassName,
}: MediaManagerProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [previewFile, setPreviewFile] = useState<MediaFile | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [pendingDeleteFileId, setPendingDeleteFileId] = useState<string | null>(
    null,
  );
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);
  const [folderSidebarCollapsed, setFolderSidebarCollapsed] = useState(false); // FIXED: Expanded by default for better UX

  // Use custom hooks
  const {
    files,
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
  } = useFolders(false);

  const { isUploading, uploadProgress, currentUploadStatus, uploadFiles } =
    useMediaUpload({
      maxSizeMB: maxFileSize,
      acceptedTypes: acceptedFileTypes,
      folderId: currentFolderId === "all" ? null : currentFolderId,
      onUploadComplete: (uploadedFiles) => {
        // Reload files from page 1 with correct folder context
        const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
        loadFiles(1, { ...filters, folderId: folderParam });

        // If multiple selection is enabled, auto-select uploaded files and enter selection mode
        if (onSelectMultiple && uploadedFiles.length > 0) {
          const newFileIds = uploadedFiles.map((f) => f.id);
          setTimeout(() => {
            setSelectedFileIds(newFileIds);
            setSelectionMode(true);
            toast({
              title: "Upload Complete",
              description: "Files uploaded. Click 'Add' to insert them.",
            });
          }, 400);
        } else if (onSelect && uploadedFiles.length > 0) {
          // Single select mode
          if (uploadedFiles.length === 1) {
            // If only one file uploaded, auto-select it immediately for better UX
            const file = uploadedFiles[0];
            const fileWithDateObject = {
              ...file,
              id: `temp_${file.id}`,
              createdAt: new Date(file.createdAt),
            };
            onSelect(fileWithDateObject);
            setDialogOpen(false);
            toast({
              title: "Image Selected",
              description: "Newly uploaded image has been selected.",
            });
          } else {
            // Multiple files uploaded in single-select mode: notify user
            toast({
              title: "Upload Complete",
              description: "Multiple files uploaded. Click one to select.",
            });
          }
        }
      },
    });

  // FIXED: Consolidated effect to prevent race conditions
  // Load files and folders when dialog opens OR when folder changes
  useEffect(() => {
    if (dialogOpen) {
      const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
      loadFiles(1, { ...filters, folderId: folderParam });
      loadFolders();
    }
  }, [dialogOpen, currentFolderId]);

  // Debounced search
  const debouncedApplyFilters = useCallback(
    debounce((newFilters) => {
      const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
      applyFilters({ ...newFilters, folderId: folderParam });
    }, 500),
    [applyFilters, currentFolderId],
  );

  useEffect(() => {
    if (dialogOpen && filters.search !== undefined) {
      debouncedApplyFilters(filters);
    }
  }, [filters.search, dialogOpen]);

  // Selection handlers
  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds((prev) =>
      prev.includes(fileId)
        ? prev.filter((id) => id !== fileId)
        : [...prev, fileId],
    );
  };

  const toggleSelectionMode = () => {
    if (selectionMode) {
      setSelectedFileIds([]);
    }
    setSelectionMode(!selectionMode);
  };

  const selectAllFiles = () => {
    const allFileIds = files.map((file) => file.id);
    setSelectedFileIds(allFileIds);
  };

  const clearSelection = () => {
    setSelectedFileIds([]);
  };

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
      setDialogOpen(false);
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

  const handleFileDelete = async () => {
    if (!pendingDeleteFileId) return;
    await deleteFile(pendingDeleteFileId);
    // Reload with correct folder context
    const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
    loadFiles(1, { ...filters, folderId: folderParam });
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
    // Reload with correct folder context
    const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
    loadFiles(1, { ...filters, folderId: folderParam });
    setSelectedFileIds([]);
    setShowBulkDeleteDialog(false);
  };

  const handleMoveToFolder = async (folderId: string | null) => {
    if (selectedFileIds.length === 0) return;

    try {
      await MediaApiClient.moveFilesToFolder(selectedFileIds, folderId);
      toast({
        title: "Files Moved",
        description: `Successfully moved ${selectedFileIds.length} file${selectedFileIds.length !== 1 ? "s" : ""}.`,
      });
      setSelectedFileIds([]);
      // Reload with correct folder context
      const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
      loadFiles(1, { ...filters, folderId: folderParam });
    } catch (error: any) {
      toast({
        title: "Move Failed",
        description: error.message || "Could not move files. Please try again.",
        variant: "destructive",
      });
    }
  };

  const handleAddSelectedFiles = () => {
    if (selectedFileIds.length === 0 || !onSelectMultiple) return;

    const selectedMediaFiles = files.filter((file) =>
      selectedFileIds.includes(file.id),
    );
    const filesWithDateObjects = selectedMediaFiles.map((file) => ({
      ...file,
      id: `temp_${file.id}`,
      createdAt: new Date(file.createdAt),
    }));

    onSelectMultiple(filesWithDateObjects);
    setDialogOpen(false);
  };

  // Preview navigation
  const navigateToNextImage = () => {
    if (!previewFile) return;
    const currentIndex = files.findIndex((file) => file.id === previewFile.id);
    if (currentIndex < files.length - 1) {
      setPreviewFile(files[currentIndex + 1]);
    }
  };

  const navigateToPrevImage = () => {
    if (!previewFile) return;
    const currentIndex = files.findIndex((file) => file.id === previewFile.id);
    if (currentIndex > 0) {
      setPreviewFile(files[currentIndex - 1]);
    }
  };

  // Reset state when dialog closes
  const handleDialogChange = (isOpen: boolean) => {
    setDialogOpen(isOpen);
    if (!isOpen) {
      setShowPreview(false);
      setSelectedFileIds([]);
      setSelectionMode(false);
      // Don't reset search or folder when closing
    }
  };

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          <Button variant="outline" className="w-full">
            <Upload className="mr-2 h-4 w-4" />
            {triggerLabel}
          </Button>
        </DialogTrigger>

        <DialogContent
          className={`max-w-7xl w-[95vw] max-h-[95vh] h-[95vh] p-0 overflow-hidden flex flex-col ${dialogClassName || ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const droppedFiles = e.dataTransfer.files;
            if (droppedFiles && droppedFiles.length > 0) {
              await uploadFiles(droppedFiles);
            }
          }}
        >
          <div className="flex h-full">
            {/* Folder sidebar */}
            <FolderBrowser
              folders={folders}
              currentFolderId={currentFolderId}
              onFolderSelect={moveToFolder}
              onFolderCreate={createFolder}
              onFolderDelete={deleteFolder}
              className={folderSidebarCollapsed ? "w-12" : "w-64"}
              isCollapsed={folderSidebarCollapsed}
              onToggleCollapse={() =>
                setFolderSidebarCollapsed(!folderSidebarCollapsed)
              }
            />

            {/* Main content */}
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Compact Header */}
              <div className="px-4 py-2 border-b shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <DialogTitle className="text-base">Media Library</DialogTitle>
                  {isUploading && uploadProgress.length > 0 && (
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Uploading {uploadProgress.length} file(s)...
                    </div>
                  )}
                </div>
                <DialogDescription className="text-xs">
                  {currentFolderId === "all"
                    ? "📁 Showing all files • Drag & drop to upload (Max 20 files, 10MB each)"
                    : currentFolderId
                      ? `📂 ${folders.find((f) => f.id === currentFolderId)?.name || "Folder"} • Max 20 files, 10MB each`
                      : "📁 Uncategorized files • Max 20 files, 10MB each"}
                </DialogDescription>
              </div>

              {/* Compact Filter bar */}
              <div className="border-b px-4 py-2 bg-muted/30 shrink-0">
                <MediaFilterBar
                  filters={filters}
                  onFiltersChange={(newFilters) => {
                    const folderParam =
                      currentFolderId === "all" ? "all" : currentFolderId;
                    applyFilters({ ...newFilters, folderId: folderParam });
                  }}
                  selectionMode={selectionMode}
                  selectedCount={selectedFileIds.length}
                  totalCount={files.length}
                  onToggleSelectionMode={toggleSelectionMode}
                  onSelectAll={selectAllFiles}
                  onClearSelection={clearSelection}
                  onBulkDelete={handleBulkDeleteConfirmation}
                  onAddSelected={handleAddSelectedFiles}
                  canAddSelected={!!onSelectMultiple}
                  folders={folders}
                  onMoveToFolder={handleMoveToFolder}
                  onUpload={uploadFiles}
                  isUploading={isUploading}
                />
              </div>

              {/* Gallery - Maximized space with upload indicator */}
              <div className="flex-1 overflow-hidden px-4 pb-4 pt-2 relative">
                {isUploading && (
                  <div className="absolute inset-0 z-10 bg-background/60 backdrop-blur-md flex items-center justify-center pointer-events-none">
                    <div className="bg-card p-6 rounded-lg shadow-lg border border-border/50 min-w-[280px]">
                      <div className="flex items-center justify-center mb-4">
                        <div className="relative">
                          <Loader2 className="h-10 w-10 animate-spin text-primary" />
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="h-6 w-6 rounded-full bg-primary/20 animate-ping" />
                          </div>
                        </div>
                      </div>
                      <p className="text-sm font-semibold text-center mb-2">
                        Uploading Files
                      </p>
                      {uploadProgress.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                              {uploadProgress.length} file(s) in progress
                            </span>
                          </div>
                          {currentUploadStatus && (
                            <p className="text-xs text-center text-muted-foreground truncate">
                              {currentUploadStatus}
                            </p>
                          )}
                          <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all duration-300 animate-pulse"
                              style={{ width: "100%" }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                <MediaGallery
                  files={files}
                  selectedFileIds={selectedFileIds}
                  selectionMode={selectionMode}
                  isLoading={isLoading}
                  isLoadingMore={isLoadingMore}
                  hasMore={currentPage < totalPages}
                  onFileSelect={handleFileSelect}
                  onFileDelete={handleDeleteConfirmation}
                  onFilePreview={handleFilePreview}
                  onToggleSelection={toggleFileSelection}
                  onLoadMore={loadMore}
                  emptyMessage={
                    filters.search
                      ? "No files match your search"
                      : "No files in this folder. Upload some files to get started!"
                  }
                  className="h-full"
                />
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <MediaPreview
        open={showPreview && dialogOpen}
        file={previewFile}
        files={files}
        onOpenChange={setShowPreview}
        onNavigateNext={navigateToNextImage}
        onNavigatePrev={navigateToPrevImage}
        onSelect={
          onSelect
            ? (file) => {
                const fileWithDateObject = {
                  ...file,
                  id: `temp_${file.id}`,
                  createdAt: new Date(file.createdAt),
                };
                onSelect(fileWithDateObject);
                setShowPreview(false);
                setDialogOpen(false);
              }
            : undefined
        }
      />

      {/* Single Delete Confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Deletion</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this file? This action cannot be
              undone and the file will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setPendingDeleteFileId(null);
                setShowDeleteDialog(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleFileDelete}
              className={buttonVariants({ variant: "destructive" })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation */}
      <AlertDialog
        open={showBulkDeleteDialog}
        onOpenChange={setShowBulkDeleteDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Bulk Deletion</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {selectedFileIds.length} selected
              file{selectedFileIds.length !== 1 ? "s" : ""}? This action cannot
              be undone and all selected files will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              className={buttonVariants({ variant: "destructive" })}
            >
              Delete {selectedFileIds.length} file
              {selectedFileIds.length !== 1 ? "s" : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
