import { ImageIcon, Loader2, Upload } from "lucide-react";
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
  onFileSelect: (file: LibraryMediaFile) => void;
  onFilePreview: (file: LibraryMediaFile, event: React.MouseEvent) => void;
  onToggleSelection: (id: string) => void;
  onLifecycle: (file: LibraryMediaFile, action: "trash" | "restore" | "permanent") => void;
  onLoadMore: () => void;
  onUploadClick?: () => void;
}

function Skeleton() {
  return <div className="overflow-hidden rounded-lg border"><div className="aspect-[4/3] animate-pulse bg-muted" /><div className="space-y-2 p-2.5"><div className="h-3 animate-pulse rounded bg-muted" /><div className="h-2 w-1/2 animate-pulse rounded bg-muted" /></div></div>;
}

export function MediaGallery(props: MediaGalleryProps) {
  if (props.isLoading && !props.files.length) {
    return <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">{Array.from({ length: 12 }, (_, index) => <Skeleton key={index} />)}</div>;
  }
  if (!props.files.length) {
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
      <div className="grid grid-cols-2 gap-2.5 p-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
        {props.files.map((file) => (
          <MediaCard
            key={file.id}
            file={file}
            posterUrl={resolveSavedPoster(file, props.files).posterUrl}
            selected={props.selectedFileIds.includes(file.id)}
            selectionMode={props.selectionMode}
            view={props.view}
            onActivate={() => props.onFileSelect(file)}
            onPreview={(event) => props.onFilePreview(file, event)}
            onToggle={() => props.onToggleSelection(file.id)}
            onLifecycle={(action) => props.onLifecycle(file, action)}
          />
        ))}
      </div>
      {props.hasMore && <div className="flex justify-center pb-4"><Button type="button" size="sm" variant="outline" className="h-8" disabled={props.isLoadingMore} onClick={props.onLoadMore}>{props.isLoadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Load more</Button></div>}
    </ScrollArea>
  );
}
