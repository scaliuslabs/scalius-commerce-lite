// Standalone MediaManager page component — uses shared useMediaManager hook

import { useState } from "react";
import { ErrorBoundary } from "../ErrorBoundary";
import { Card, CardContent } from "~/components/ui/card";
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

export function MediaManagerPage() {
  const [isDragging, setIsDragging] = useState(false);

  const mm = useMediaManager({ autoLoad: true });

  return (
    <ErrorBoundary fallback={<div className="p-4 text-center text-muted-foreground">Something went wrong loading the media manager. <button onClick={() => window.location.reload()} className="underline">Reload</button></div>}>
    <>
      <Card className="w-full overflow-hidden">
        <CardContent className="p-0">
          <div
            className="relative flex h-[calc(100svh-10rem)] min-h-[34rem] flex-col md:flex-row"
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
                await mm.uploadFiles(droppedFiles);
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
              {/* Compact header */}
              <div className="border-b px-4 py-2 bg-muted/10 shrink-0">
                <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-base font-semibold">Media Library</h2>
                  {mm.isUploading && mm.uploadProgress.length > 0 && (
                    <div className="text-xs text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Uploading {mm.uploadProgress.length} file(s)...
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {mm.currentFolderId === "all"
                    ? "Showing all files -- Drag & drop to upload (Max 20 files, 10MB each)"
                    : mm.currentFolderId
                      ? `${mm.folders.find((f) => f.id === mm.currentFolderId)?.name || "Folder"} -- Max 20 files, 10MB each`
                      : "Uncategorized files -- Max 20 files, 10MB each"}
                </p>
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
        </CardContent>
      </Card>

      {/* Preview Dialog */}
      <MediaPreview
        open={mm.showPreview}
        file={mm.previewFile}
        files={mm.files}
        onOpenChange={mm.setShowPreview}
        onNavigateNext={mm.navigateToNextImage}
        onNavigatePrev={mm.navigateToPrevImage}
        onAltTextUpdate={mm.handleAltTextUpdate}
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
    </ErrorBoundary>
  );
}
