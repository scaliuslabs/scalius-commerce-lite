// Standalone MediaManager page component

import { useState, useCallback, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";
import { MediaApiClient } from "./api";
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
import type { MediaFile } from "./types";

export function MediaManagerPage() {
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
  const [isDragging, setIsDragging] = useState(false);

  // Use custom hooks
  const {
    files,
    isLoading,
    isLoadingMore,
    currentPage,
    totalPages,
    filters,
    loadMore,
    applyFilters,
    deleteFile,
    deleteFiles: deleteMultipleFiles,
  } = useMediaFiles(false); // Disabled autoLoad - initial load handled by currentFolderId effect below (line 78-81)

  const { folders, currentFolderId, createFolder, deleteFolder, moveToFolder } =
    useFolders(true); // Auto-load on mount

  const { isUploading, uploadProgress, currentUploadStatus, uploadFiles } =
    useMediaUpload({
      folderId: currentFolderId === "all" ? null : currentFolderId,
      onUploadComplete: (uploadedFiles) => {
        // Reload files from page 1 with correct folder context
        const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
        applyFilters({ ...filters, folderId: folderParam });

        // Auto-select uploaded files for better UX
        if (uploadedFiles.length > 0) {
          const newFileIds = uploadedFiles.map((f) => f.id);
          setTimeout(() => {
            setSelectedFileIds(newFileIds);
            setSelectionMode(true);
          }, 400); // Small delay to ensure files are loaded
        }
      },
    });

  // Load files when folder changes
  useEffect(() => {
    const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
    applyFilters({ ...filters, folderId: folderParam });
  }, [currentFolderId]);

  // Debounced search
  const debouncedApplyFilters = useCallback(
    debounce((newFilters) => {
      const folderParam = currentFolderId === "all" ? "all" : currentFolderId;
      applyFilters({ ...newFilters, folderId: folderParam });
    }, 500),
    [applyFilters, currentFolderId],
  );

  useEffect(() => {
    if (filters.search !== undefined) {
      debouncedApplyFilters(filters);
    }
  }, [filters.search]);

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
    applyFilters({ ...filters, folderId: folderParam });
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
    applyFilters({ ...filters, folderId: folderParam });
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
      applyFilters({ ...filters, folderId: folderParam });
    } catch (error: any) {
      toast({
        title: "Move Failed",
        description: error.message || "Could not move files. Please try again.",
        variant: "destructive",
      });
    }
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

  return (
    <>
      <Card className="w-full">
        <CardContent className="p-0">
          <div
            className="flex h-[calc(100vh-10rem)] relative"
            onDragEnter={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(true);
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const target = e.currentTarget;
              if (!target.contains(e.relatedTarget as Node)) {
                setIsDragging(false);
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsDragging(false);
              const droppedFiles = e.dataTransfer.files;
              if (droppedFiles && droppedFiles.length > 0) {
                await uploadFiles(droppedFiles);
              }
            }}
          >
            {isDragging && (
              <div className="absolute inset-0 z-50 bg-primary/10 backdrop-blur-sm flex items-center justify-center border-4 border-dashed border-primary rounded-lg">
                <div className="bg-background p-8 rounded-lg shadow-lg">
                  <Upload className="h-16 w-16 text-primary mx-auto mb-4" />
                  <p className="text-xl font-semibold text-center">
                    Drop files to upload
                  </p>
                </div>
              </div>
            )}
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
              {/* Compact header */}
              <div className="border-b px-4 py-2 bg-muted/10 shrink-0">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-base font-semibold">Media Library</h2>
                  {isUploading && uploadProgress.length > 0 && (
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Uploading {uploadProgress.length} file(s)...
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {currentFolderId === "all"
                    ? "📁 Showing all files • Drag & drop to upload (Max 20 files, 10MB each)"
                    : currentFolderId
                      ? `📂 ${folders.find((f) => f.id === currentFolderId)?.name || "Folder"} • Max 20 files, 10MB each`
                      : "📁 Uncategorized files • Max 20 files, 10MB each"}
                </p>
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
                  folders={folders}
                  onMoveToFolder={handleMoveToFolder}
                  onUpload={uploadFiles}
                  isUploading={isUploading}
                />
              </div>

              {/* Gallery - Maximized space */}
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
        </CardContent>
      </Card>

      {/* Preview Dialog */}
      <MediaPreview
        open={showPreview}
        file={previewFile}
        files={files}
        onOpenChange={setShowPreview}
        onNavigateNext={navigateToNextImage}
        onNavigatePrev={navigateToPrevImage}
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
