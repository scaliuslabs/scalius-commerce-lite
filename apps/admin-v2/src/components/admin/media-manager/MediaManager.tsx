// Main MediaManager component (Dialog version for selecting media) — uses shared useMediaManager hook

import React, { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
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
} from "~/components/ui/alert-dialog";
import { buttonVariants } from "~/components/ui/button";
import {
  MediaGallery,
  MediaPreview,
  MediaFilterBar,
  FolderBrowser,
} from "./components";
import { useMediaManager } from "./hooks/useMediaManager";
import type { MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  initialOpen?: boolean;
  onInitialOpenHandled?: () => void;
};

export function MediaManager({
  onSelect,
  onSelectMultiple,
  selectedFiles = [],
  triggerLabel = "Select Image",
  trigger,
  acceptedFileTypes = "image/*",
  maxFileSize = 10,
  dialogClassName,
  initialOpen = false,
  onInitialOpenHandled,
}: MediaManagerInternalProps) {
  const [dialogOpen, setDialogOpen] = React.useState(initialOpen);

  const mm = useMediaManager({
    autoLoad: false,
    maxFileSize,
    acceptedFileTypes,
    onSelect: onSelect
      ? (file) => {
          onSelect(file);
          setDialogOpen(false);
        }
      : undefined,
    onSelectMultiple: onSelectMultiple
      ? (files) => {
          onSelectMultiple(files);
          setDialogOpen(false);
        }
      : undefined,
  });

  // Load files and folders when dialog opens OR when folder changes
  useEffect(() => {
    if (dialogOpen) {
      const fid = mm.currentFolderId;
      const folderParam = fid === "all" ? "all" : fid === null ? "root" : fid;
      mm.loadFiles(1, { ...mm.filters, folderId: folderParam });
      mm.loadFolders();
    }
  }, [dialogOpen, mm.currentFolderId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!initialOpen) return;
    setDialogOpen(true);
    onInitialOpenHandled?.();
  }, [initialOpen, onInitialOpenHandled]);

  // Initialize selection when dialog opens
  useEffect(() => {
    if (dialogOpen) {
      if (selectedFiles && selectedFiles.length > 0) {
        const ids = selectedFiles.map((f) => f.id.replace(/^temp_/, ""));
        mm.setSelectedFileIds(ids);
        mm.setSelectionMode(true);
      } else {
        mm.setSelectedFileIds([]);
        mm.setSelectionMode(false);
      }
    }
  }, [dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  useEffect(() => {
    if (dialogOpen && mm.filters.search !== undefined) {
      mm.debouncedApplyFilters(mm.filters);
    }
  }, [mm.filters.search, dialogOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset state when dialog closes
  const handleDialogChange = (isOpen: boolean) => {
    setDialogOpen(isOpen);
    if (!isOpen) {
      mm.setShowPreview(false);
    }
  };

  return (
    <>
      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          {React.isValidElement(trigger) ? (
            trigger
          ) : (
            <Button type="button" variant="outline" className="w-full">
              <Upload className="mr-2 h-4 w-4" />
              {triggerLabel}
            </Button>
          )}
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
              await mm.uploadFiles(droppedFiles);
            }
          }}
        >
          <div className="flex h-full min-h-0 flex-col md:flex-row">
            {/* Folder sidebar */}
            <FolderBrowser
              folders={mm.folders}
              currentFolderId={mm.currentFolderId}
              onFolderSelect={mm.moveToFolder}
              onFolderCreate={mm.createFolder}
              onFolderDelete={mm.deleteFolder}
              className={mm.folderSidebarCollapsed ? "w-full shrink-0 md:w-12" : "w-full shrink-0 md:w-64"}
              isCollapsed={mm.folderSidebarCollapsed}
              onToggleCollapse={() =>
                mm.setFolderSidebarCollapsed(!mm.folderSidebarCollapsed)
              }
            />

            {/* Main content */}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {/* Compact Header */}
              <div className="px-4 py-2 border-b shrink-0">
                <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <DialogTitle className="text-base">Media Library</DialogTitle>
                  {mm.isUploading && mm.uploadProgress.length > 0 && (
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Uploading {mm.uploadProgress.length} file(s)...
                    </div>
                  )}
                </div>
                <DialogDescription className="text-xs">
                  {mm.currentFolderId === "all"
                    ? "Showing all files -- Drag & drop to upload (Max 20 files, 10MB each)"
                    : mm.currentFolderId
                      ? `${mm.folders.find((f) => f.id === mm.currentFolderId)?.name || "Folder"} -- Max 20 files, 10MB each`
                      : "Uncategorized files -- Max 20 files, 10MB each"}
                </DialogDescription>
              </div>

              {/* Compact Filter bar */}
              <div className="border-b px-4 py-2 bg-muted/30 shrink-0">
                <MediaFilterBar
                  filters={mm.filters}
                  onFiltersChange={(newFilters) => {
                    const folderParam =
                      mm.currentFolderId === "all"
                        ? "all"
                        : mm.currentFolderId === null
                          ? "root"
                          : mm.currentFolderId;
                    mm.applyFilters({ ...newFilters, folderId: folderParam });
                  }}
                  selectionMode={mm.selectionMode}
                  selectedCount={mm.selectedFileIds.length}
                  totalCount={mm.files.length}
                  onToggleSelectionMode={mm.toggleSelectionMode}
                  onSelectAll={mm.selectAllFiles}
                  onClearSelection={mm.clearSelection}
                  onBulkDelete={mm.handleBulkDeleteConfirmation}
                  onAddSelected={mm.handleAddSelectedFiles}
                  canAddSelected={!!onSelectMultiple}
                  folders={mm.folders}
                  onMoveToFolder={mm.handleMoveToFolder}
                  onUpload={mm.uploadFiles}
                  isUploading={mm.isUploading}
                />
              </div>

              {/* Gallery */}
              <div className="relative min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-2">
                {mm.isUploading && (
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
                      {mm.uploadProgress.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                              {mm.uploadProgress.length} file(s) in progress
                            </span>
                          </div>
                          {mm.currentUploadStatus && (
                            <p className="text-xs text-center text-muted-foreground truncate">
                              {mm.currentUploadStatus}
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
                  files={mm.files}
                  selectedFileIds={mm.selectedFileIds}
                  selectionMode={mm.selectionMode}
                  isLoading={mm.isLoading}
                  isLoadingMore={mm.isLoadingMore}
                  hasMore={mm.currentPage < mm.totalPages}
                  onFileSelect={mm.handleFileSelect}
                  onFileDelete={mm.handleDeleteConfirmation}
                  onFilePreview={mm.handleFilePreview}
                  onToggleSelection={mm.toggleFileSelection}
                  onEditAltText={(file) => {
                    mm.setPreviewFile(file);
                    mm.setShowPreview(true);
                  }}
                  onLoadMore={mm.loadMore}
                  emptyMessage={
                    mm.filters.search
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
        open={mm.showPreview && dialogOpen}
        file={mm.previewFile}
        files={mm.files}
        onOpenChange={mm.setShowPreview}
        onNavigateNext={mm.navigateToNextImage}
        onNavigatePrev={mm.navigateToPrevImage}
        onAltTextUpdate={mm.handleAltTextUpdate}
        onSelect={
          onSelect
            ? (file) => {
                const fileWithDateObject = {
                  ...file,
                  id: `temp_${file.id}`,
                  createdAt: new Date(file.createdAt),
                };
                onSelect(fileWithDateObject);
                mm.setShowPreview(false);
                setDialogOpen(false);
              }
            : undefined
        }
      />

      {/* Single Delete Confirmation */}
      <AlertDialog open={mm.showDeleteDialog} onOpenChange={mm.setShowDeleteDialog}>
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
                mm.setPendingDeleteFileId(null);
                mm.setShowDeleteDialog(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={mm.handleFileDelete}
              className={buttonVariants({ variant: "destructive" })}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation */}
      <AlertDialog
        open={mm.showBulkDeleteDialog}
        onOpenChange={mm.setShowBulkDeleteDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Bulk Deletion</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete {mm.selectedFileIds.length} selected
              file{mm.selectedFileIds.length !== 1 ? "s" : ""}? This action cannot
              be undone and all selected files will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={mm.handleBulkDelete}
              className={buttonVariants({ variant: "destructive" })}
            >
              Delete {mm.selectedFileIds.length} file
              {mm.selectedFileIds.length !== 1 ? "s" : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
