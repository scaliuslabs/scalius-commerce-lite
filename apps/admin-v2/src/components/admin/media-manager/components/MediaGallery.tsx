import { AlertCircle, ImageIcon, Loader2, RotateCcw, Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";
import { MediaCard } from "./MediaCard";
import type { LibraryMediaFile, MediaLibraryView } from "../types";
import { resolveSavedPoster } from "../utils/poster";

interface MediaGalleryProps {
  files: LibraryMediaFile[];
  selectedFileIds: string[];
  selectionMode: boolean;
  view: MediaLibraryView;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadError: string | null;
  onFileSelect: (file: LibraryMediaFile, extendRange?: boolean) => void;
  onFilePreview: (file: LibraryMediaFile, event: React.MouseEvent) => void;
  onToggleSelection: (id: string, extendRange?: boolean) => void;
  onLifecycle: (file: LibraryMediaFile, action: "trash" | "restore" | "permanent") => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onUploadClick?: () => void;
}

function Skeleton() {
  return <div className="overflow-hidden rounded-lg border"><div className="aspect-[4/3] animate-pulse bg-muted" /><div className="space-y-2 p-2.5"><div className="h-3 animate-pulse rounded bg-muted" /><div className="h-2 w-1/2 animate-pulse rounded bg-muted" /></div></div>;
}

export function MediaGallery(props: MediaGalleryProps) {
  if (props.isLoading && !props.files.length) {
    return <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{Array.from({ length: 15 }, (_, index) => <Skeleton key={index} />)}</div>;
  }
  if (!props.files.length) {
    if (props.loadError) {
      return (
        <div className="flex h-full min-h-72 flex-col items-center justify-center px-6 text-center" role="alert">
          <span className="mb-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3"><AlertCircle className="h-6 w-6 text-destructive" /></span>
          <h3 className="text-sm font-semibold">Media could not be loaded</h3>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{props.loadError}</p>
          <Button type="button" size="sm" variant="outline" className="mt-4 h-8" onClick={props.onRetry}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Try again</Button>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-72 flex-col items-center justify-center px-6 text-center">
        <span className="mb-3 rounded-xl border bg-muted/40 p-3"><ImageIcon className="h-6 w-6 text-muted-foreground" /></span>
        <h3 className="text-sm font-semibold">{props.view === "trash" ? "Trash is empty" : "No matching assets"}</h3>
        <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">{props.view === "trash" ? "Assets moved to trash stay here until restored or permanently deleted." : "Change the search, folder, or type filter—or upload a new asset."}</p>
        {props.view === "ready" && props.onUploadClick && <Button type="button" size="sm" className="mt-4 h-8" onClick={props.onUploadClick}><Upload className="mr-1.5 h-3.5 w-3.5" />Upload assets</Button>}
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      {props.loadError && <div className="mx-3 mt-3 flex items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200" role="status"><AlertCircle className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1">Could not refresh. The previous results are still shown.</span><Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={props.onRetry}>Retry</Button></div>}
      <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {props.files.map((file) => (
          <MediaCard
            key={file.id}
            file={file}
            posterUrl={resolveSavedPoster(file, props.files).posterUrl}
            selected={props.selectedFileIds.includes(file.id)}
            selectionMode={props.selectionMode}
            view={props.view}
            onActivate={(event) => props.onFileSelect(file, event.shiftKey)}
            onPreview={(event) => props.onFilePreview(file, event)}
            onToggle={(event) => props.onToggleSelection(file.id, event.shiftKey)}
            onLifecycle={(action) => props.onLifecycle(file, action)}
          />
        ))}
      </div>
      {props.hasMore && <div className="flex justify-center pb-4"><Button type="button" size="sm" variant="outline" className="h-8" disabled={props.isLoadingMore} onClick={props.onLoadMore}>{props.isLoadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Load more</Button></div>}
    </ScrollArea>
  );
}
