import { useState } from "react";
import { Image, Trash2, Upload } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { FolderBrowser, MediaFilterBar, MediaGallery, MediaPreview, MediaUploadQueue } from "./components";
import type { useMediaManager } from "./hooks/useMediaManager";
import type { LibraryMediaFile, MediaCapability, MediaFile } from "./types";

interface MediaWorkspaceProps {
  manager: ReturnType<typeof useMediaManager>;
  capability: MediaCapability;
  picker?: boolean;
  multiple?: boolean;
  onSelect?: (file: MediaFile) => void;
  onClose?: () => void;
}

export function MediaWorkspace({ manager: mm, capability, picker = false, multiple = false, onSelect, onClose }: MediaWorkspaceProps) {
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<{ file?: LibraryMediaFile; bulk?: true } | null>(null);
  const lifecycle = (file: LibraryMediaFile, action: "trash" | "restore" | "permanent") => {
    if (action === "permanent") setConfirm({ file });
    else void mm.mutateOne(file, action);
  };
  const bulkLifecycle = (action: "trash" | "restore" | "permanent") => {
    if (action === "permanent") setConfirm({ bulk: true });
    else void mm.mutateSelected(action);
  };
  const navigate = (direction: -1 | 1) => {
    if (!mm.previewFile) return;
    const index = mm.files.findIndex((file) => file.id === mm.previewFile?.id);
    const next = mm.files[index + direction];
    if (next) mm.setPreviewFile(next);
  };

  return (
    <div
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); if (mm.view === "ready") void mm.uploadFiles(event.dataTransfer.files); }}
    >
      {dragging && mm.view === "ready" && <div className="absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-foreground/40 bg-background/95"><div className="text-center"><Upload className="mx-auto h-7 w-7" /><p className="mt-2 text-sm font-semibold">Drop to add assets</p><p className="mt-1 text-xs text-muted-foreground">Images up to 20 MiB · MP4/WebM up to 100 MiB</p></div></div>}

      <header className="flex min-h-12 flex-wrap items-center gap-3 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{picker ? `Choose ${capability === "both" ? "media" : capability}` : "Media"}</h2>
          <p className="truncate text-xs text-muted-foreground">Images up to 20 MiB · videos up to 100 MiB · 50 files per batch</p>
        </div>
        {!picker && <div className="flex rounded-md border p-0.5" role="group" aria-label="Media view"><Button type="button" aria-pressed={mm.view === "ready"} variant="ghost" size="sm" className={cn("h-7 px-2.5 text-xs", mm.view === "ready" && "bg-muted")} onClick={() => mm.setView("ready")}><Image className="mr-1.5 h-3.5 w-3.5" />Library</Button><Button type="button" aria-pressed={mm.view === "trash"} variant="ghost" size="sm" className={cn("h-7 px-2.5 text-xs", mm.view === "trash" && "bg-muted")} onClick={() => mm.setView("trash")}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Trash</Button></div>}
        {onClose && <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onClose}>Close</Button>}
      </header>

      <MediaUploadQueue queue={mm.queue} onPause={mm.pause} onResume={mm.resume} onCancel={mm.cancel} onClearFinished={mm.clearFinished} />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <FolderBrowser folders={mm.folders} currentFolderId={mm.currentFolderId} onFolderSelect={mm.moveToFolder} onFolderCreate={mm.createFolder} onFolderRename={mm.renameFolder} onFolderDelete={mm.deleteFolder} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <MediaFilterBar capability={capability} filters={mm.filters} view={mm.view} selectedCount={mm.selectedFileIds.length} visibleCount={mm.files.length} folders={mm.folders} isMutating={mm.isMutating} allowSelection={!picker || multiple} onSearch={mm.applySearch} onFiltersChange={mm.applyFilters} onUpload={mm.uploadFiles} onSelectAll={() => { mm.setSelectionMode(true); mm.setSelectedFileIds(mm.files.map((file) => file.id)); }} onClearSelection={() => { mm.setSelectedFileIds([]); mm.setSelectionMode(false); }} onMove={(folderId) => void mm.moveSelected(folderId)} onLifecycle={bulkLifecycle} onAddSelected={picker && multiple && mm.selectedFileIds.length ? mm.addSelected : undefined} />
          <div className="min-h-0 flex-1">
            <MediaGallery files={mm.files} selectedFileIds={mm.selectedFileIds} selectionMode={mm.selectionMode} view={mm.view} isLoading={mm.isLoading} isLoadingMore={mm.isLoadingMore} hasMore={mm.hasMore} loadError={mm.loadError} onFileSelect={mm.handleFileSelect} onFilePreview={(file, event) => { event.stopPropagation(); mm.setPreviewFile(file); mm.setShowPreview(true); }} onToggleSelection={mm.toggleSelection} onLifecycle={lifecycle} onLoadMore={mm.loadMore} onRetry={() => void mm.refresh()} />
          </div>
        </main>
      </div>

      <MediaPreview open={mm.showPreview} file={mm.previewFile} files={mm.files} onOpenChange={mm.setShowPreview} onNavigate={navigate} onUpdate={mm.updateFile} onSelect={onSelect} />
      <AlertDialog open={!!confirm} onOpenChange={(value) => !value && setConfirm(null)}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Delete permanently?</AlertDialogTitle><AlertDialogDescription>This removes the R2 object after dependency checks. It cannot be undone. Referenced assets will be blocked.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Keep in trash</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { if (confirm?.file) void mm.mutateOne(confirm.file, "permanent"); else if (confirm?.bulk) void mm.mutateSelected("permanent"); setConfirm(null); }}>Delete permanently</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
