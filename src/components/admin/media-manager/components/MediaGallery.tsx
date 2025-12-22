// Media gallery grid component with smooth loading states

import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Loader2, ImageIcon } from "lucide-react";
import { MediaCard } from "./MediaCard";
import type { MediaFile } from "../types";

interface MediaGalleryProps {
  files: MediaFile[];
  selectedFileIds: string[];
  selectionMode: boolean;
  isLoading?: boolean;
  isLoadingMore?: boolean;
  hasMore?: boolean;
  onFileSelect: (file: MediaFile) => void;
  onFileDelete: (fileId: string) => void;
  onFilePreview: (file: MediaFile, e: React.MouseEvent) => void;
  onToggleSelection: (fileId: string) => void;
  onLoadMore?: () => void;
  emptyMessage?: string;
  className?: string;
}

// Skeleton loader component - simple and clean
function MediaCardSkeleton() {
  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="p-2">
        <div className="relative aspect-square overflow-hidden rounded-md bg-muted/40" />
        <div className="mt-2 space-y-2">
          <div className="h-3 bg-muted/40 rounded" />
          <div className="flex justify-between">
            <div className="h-2 w-12 bg-muted/40 rounded" />
            <div className="h-2 w-16 bg-muted/40 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function MediaGallery({
  files,
  selectedFileIds,
  selectionMode,
  isLoading = false,
  isLoadingMore = false,
  hasMore = false,
  onFileSelect,
  onFileDelete,
  onFilePreview,
  onToggleSelection,
  onLoadMore,
  emptyMessage = "No media files found",
  className = "",
}: MediaGalleryProps) {
  // Show skeleton grid while loading initial files (12 cards to match page size)
  if (isLoading && files.length === 0) {
    return (
      <ScrollArea className={`h-full rounded-md border ${className}`}>
        <div className="p-4">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {Array.from({ length: 12 }).map((_, i) => (
              <MediaCardSkeleton key={i} />
            ))}
          </div>
        </div>
      </ScrollArea>
    );
  }

  // Show empty state if no files and not loading
  if (files.length === 0 && !isLoading) {
    return (
      <div className="flex h-[50vh] flex-col items-center justify-center text-muted-foreground py-10 border rounded-md">
        <ImageIcon className="h-20 w-20 mb-6 text-gray-300 dark:text-gray-600" />
        <h3 className="text-xl font-semibold mb-2">No Files Found</h3>
        <p className="text-center text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <ScrollArea className={`h-full rounded-md border ${className}`}>
      <div className="p-4">
        {/* File grid with smooth transitions */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {files.map((file) => (
            <MediaCard
              key={file.id}
              file={file}
              isSelected={selectedFileIds.includes(file.id)}
              selectionMode={selectionMode}
              onSelect={() => onFileSelect(file)}
              onDelete={() => onFileDelete(file.id)}
              onPreview={(e) => onFilePreview(file, e)}
              onToggleSelection={() => onToggleSelection(file.id)}
            />
          ))}
        </div>

        {/* Loading overlay while switching folders - show existing files with overlay */}
        {isLoading && files.length > 0 && (
          <div className="mt-4 flex justify-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-4 py-2 rounded-full">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading files...</span>
            </div>
          </div>
        )}

        {/* Load More Button */}
        {hasMore && !isLoadingMore && onLoadMore && (
          <div className="mt-6 flex justify-center">
            <Button onClick={onLoadMore} variant="outline" size="sm">
              Load More
            </Button>
          </div>
        )}

        {/* Loading more indicator */}
        {isLoadingMore && (
          <div className="mt-6 flex justify-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading more files...</span>
            </div>
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
