import { useState, type MouseEvent } from "react";
import { Check, MoreHorizontal, Play, RotateCcw, Search, Trash2 } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { LibraryMediaFile, MediaLibraryView } from "../types";
import { formatFileSize } from "../utils";

interface MediaCardProps {
  file: LibraryMediaFile;
  posterUrl?: string | null;
  selected: boolean;
  selectionMode: boolean;
  view: MediaLibraryView;
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
  onPreview: (event: MouseEvent) => void;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onLifecycle: (action: "trash" | "restore" | "permanent") => void;
}

export function MediaCard({ file, posterUrl, selected, selectionMode, view, onActivate, onPreview, onToggle, onLifecycle }: MediaCardProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const isImage = file.kind === "image";
  const previewUrl = isImage
    ? getOptimizedImageUrl(file.url, { width: 480, height: 360, fit: "contain", quality: 82 })
    : posterUrl
      ? getOptimizedImageUrl(posterUrl, { width: 480, height: 360, fit: "contain", quality: 82 })
      : null;

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-card transition-colors focus-within:border-foreground/40",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      <button
        type="button"
        className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={selectionMode ? onToggle : onActivate}
        aria-pressed={selectionMode ? selected : undefined}
        aria-keyshortcuts={selectionMode ? "Shift+Enter" : undefined}
        aria-label={`${selectionMode ? (selected ? "Deselect" : "Select") : "Open"} ${file.filename}`}
        title={selectionMode ? "Hold Shift to select a range" : undefined}
      >
        <div className="relative aspect-[4/3] overflow-hidden bg-muted">
          {previewUrl && !loadFailed ? (
            <img
              src={previewUrl}
              alt={isImage ? (file.altText || file.filename) : ""}
              className="h-full w-full object-contain"
              loading="lazy"
              decoding="async"
              onError={() => setLoadFailed(true)}
            />
          ) : (
            <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,hsl(var(--muted)),hsl(var(--background)))] text-muted-foreground">
              {file.kind === "video" ? <Play className="h-8 w-8" aria-hidden="true" /> : <span className="text-xs">Preview unavailable</span>}
            </div>
          )}
          {file.kind === "video" && (
            <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/75 px-1.5 py-1 text-[11px] font-medium text-white">
              <Play className="h-3 w-3 fill-current" aria-hidden="true" /> Video
            </span>
          )}
          {selectionMode && (
            <span aria-hidden="true" className={cn("absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded border bg-background/90 shadow-sm", selected && "border-primary bg-primary text-primary-foreground")}>{selected && <Check className="h-3.5 w-3.5" />}</span>
          )}
        </div>
        <div className="px-2.5 py-2">
          <p className="truncate text-[13px] font-medium" title={file.filename}>{file.filename}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="capitalize">{file.kind}</span><span aria-hidden="true">·</span><span>{formatFileSize(file.size)}</span>
          </p>
        </div>
      </button>

      <div className="absolute right-1.5 top-1.5 flex gap-1">
        <Button type="button" variant="secondary" size="icon" className="h-7 w-7 bg-background/90" onClick={onPreview} aria-label={`Preview ${file.filename}`}>
          <Search className="h-3.5 w-3.5" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" size="icon" className="h-7 w-7 bg-background/90" onClick={(event) => event.stopPropagation()} aria-label={`Actions for ${file.filename}`}>
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {view === "ready" ? (
              <DropdownMenuItem onSelect={() => onLifecycle("trash")}><Trash2 className="mr-2 h-4 w-4" />Move to trash</DropdownMenuItem>
            ) : (
              <>
                <DropdownMenuItem onSelect={() => onLifecycle("restore")}><RotateCcw className="mr-2 h-4 w-4" />Restore</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onLifecycle("permanent")}><Trash2 className="mr-2 h-4 w-4" />Delete permanently</DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
