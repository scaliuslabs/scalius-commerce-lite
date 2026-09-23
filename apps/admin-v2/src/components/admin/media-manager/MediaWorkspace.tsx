import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { MediaFilterBar, MediaGallery, MediaPreview, MediaUploadQueue } from "./components";
import { OptimizeImagesButton } from "./components/OptimizeImagesButton";
import type { useMediaManager } from "./hooks/useMediaManager";
import { capabilityAccept, mediaLimitKey, type LibraryMediaFile, type MediaCapability, type MediaFile } from "./types";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";

interface MediaWorkspaceProps {
  manager: ReturnType<typeof useMediaManager>;
  capability: MediaCapability;
  picker?: boolean;
  multiple?: boolean;
  onSelect?: (file: MediaFile) => void;
  onClose?: () => void;
}

type Lifecycle = "trash" | "restore" | "permanent";

/**
 * The Files workspace: the /admin/media page (header, tabs, one card) and the
 * picker body inside MediaManager's dialog (toolbar, grid, Cancel/Add footer).
 */
export function MediaWorkspace({ manager: mm, capability, picker = false, multiple = false, onSelect, onClose }: MediaWorkspaceProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState<{ file?: LibraryMediaFile } | null>(null);
  const { cancelSelection, selectionMode, showPreview } = mm;
  const canUpload = mm.view === "ready";
  const filtered = Boolean(mm.filters.search) || (capability === "both" && Boolean(mm.filters.kind)) || mm.currentFolderId !== "all";

  const lifecycle = (file: LibraryMediaFile, action: Lifecycle) => {
    if (action === "permanent") setConfirm({ file });
    else void mm.mutateOne(file, action);
  };
  const bulkLifecycle = (action: Lifecycle) => {
    if (action === "permanent") setConfirm({});
    else void mm.mutateSelected(action);
  };
  const navigate = (direction: -1 | 1) => {
    const index = mm.files.findIndex((file) => file.id === mm.previewFile?.id);
    const next = mm.files[index + direction];
    if (index >= 0 && next) mm.setPreviewFile(next);
  };

  useEffect(() => {
    if (picker || !selectionMode || showPreview || confirm) return;
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      event.preventDefault();
      cancelSelection();
    };
    document.addEventListener("keydown", cancelWithEscape);
    return () => document.removeEventListener("keydown", cancelWithEscape);
  }, [cancelSelection, confirm, picker, selectionMode, showPreview]);

  const body = (
    <>
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        accept={capabilityAccept(capability)}
        onChange={(event) => {
          void mm.uploadFiles(event.target.files);
          event.currentTarget.value = "";
        }}
      />
      {!picker ? (
        <IndexTabs
          label={t("title")}
          tabs={[{ value: "ready", label: r("all") }, { value: "trash", label: r("trash") }]}
          value={mm.view}
          onChange={mm.setView}
        />
      ) : null}
      <MediaFilterBar
        capability={capability}
        filters={mm.filters}
        view={mm.view}
        selectedCount={mm.selectedFileIds.length}
        selectableCount={mm.selectableFileCount}
        selectionMode={mm.selectionMode}
        folders={mm.folders}
        currentFolderId={mm.currentFolderId}
        isMutating={mm.isMutating}
        allowSelection={!picker || multiple}
        allowManagement={!picker}
        onSearch={mm.applySearch}
        onFiltersChange={mm.applyFilters}
        onUploadClick={canUpload ? () => inputRef.current?.click() : undefined}
        onFolderSelect={mm.moveToFolder}
        onFolderCreate={mm.createFolder}
        onFolderRename={mm.renameFolder}
        onFolderDelete={mm.deleteFolder}
        onBeginSelection={mm.beginSelection}
        onSelectAll={mm.selectAllVisible}
        onClearSelection={() => mm.clearSelection(true)}
        onCancelSelection={!picker ? mm.cancelSelection : undefined}
        onMove={(folderId) => void mm.moveSelected(folderId)}
        onLifecycle={bulkLifecycle}
      />
      <MediaUploadQueue queue={mm.queue} onPause={mm.pause} onResume={mm.resume} onCancel={mm.cancel} onClearFinished={mm.clearFinished} />
      <div className={picker ? "min-h-0 flex-1 overflow-y-auto" : undefined}>
        <MediaGallery
          files={mm.files}
          selectedFileIds={mm.selectedFileIds}
          isFileUnavailable={mm.isFileUnavailable}
          selectionMode={mm.selectionMode}
          allowManagement={!picker}
          view={mm.view}
          filtered={filtered}
          isLoading={mm.isLoading}
          isLoadingMore={mm.isLoadingMore}
          hasMore={mm.hasMore}
          loadError={mm.loadError}
          onFileSelect={mm.handleFileSelect}
          onFilePreview={(file) => {
            mm.setPreviewFile(file);
            mm.setShowPreview(true);
          }}
          onToggleSelection={mm.toggleSelection}
          onLifecycle={lifecycle}
          onLoadMore={mm.loadMore}
          onRetry={() => void mm.refresh()}
          onClearFilters={mm.clearFilters}
          onUploadClick={canUpload ? () => inputRef.current?.click() : undefined}
        />
      </div>
    </>
  );

  const selected = mm.selectedFileIds.length;
  return (
    <div
      className={picker ? "relative flex min-h-0 flex-1 flex-col" : "relative pb-8"}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (canUpload) void mm.uploadFiles(event.dataTransfer.files);
      }}
    >
      {dragging && canUpload ? (
        <div className="pointer-events-none absolute inset-2 z-50 flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-ring bg-card text-center">
          <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
          <p className="text-heading-sm">{t("dropToUpload")}</p>
          <p className="text-body text-muted-foreground">{t(mediaLimitKey(capability))}</p>
        </div>
      ) : null}

      {picker ? (
        <>
          {body}
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
            {multiple ? <span className="mr-auto text-body text-muted-foreground" aria-live="polite">{r("selected", { count: selected })}</span> : null}
            <Button type="button" variant="outline" onClick={onClose}>{r("cancel")}</Button>
            {multiple ? (
              <Button type="button" disabled={!selected || mm.isMutating} onClick={mm.addSelected}>
                {selected ? t("addCount", { count: selected }) : t("add")}
              </Button>
            ) : null}
          </footer>
        </>
      ) : (
        <>
          <PageHeader title={t("title")} actions={canUpload ? <OptimizeImagesButton onOptimized={() => void mm.refresh()} /> : null} />
          <div className="overflow-hidden rounded-xl bg-card shadow-card">{body}</div>
        </>
      )}

      <MediaPreview
        open={mm.showPreview}
        file={mm.previewFile}
        files={mm.files}
        onOpenChange={mm.setShowPreview}
        onNavigate={navigate}
        onUpdate={mm.updateFile}
        onSelect={onSelect}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirm?.file ? t("deleteOneTitle", { name: confirm.file.filename }) : t("deleteManyTitle", { count: selected })}
        description={t("deleteBody")}
        confirmLabel={r("deletePermanently")}
        cancelLabel={r("cancel")}
        onConfirm={() => {
          if (confirm?.file) void mm.mutateOne(confirm.file, "permanent");
          else void mm.mutateSelected("permanent");
          setConfirm(null);
        }}
      />
    </div>
  );
}
