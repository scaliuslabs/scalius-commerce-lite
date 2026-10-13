import { useEffect, useRef, useState } from "react";
import { useMediaPermissions } from "./hooks/useMediaPermissions";
import { ReadOnlyNotice } from "~/components/admin/resource/ReadOnlyNotice";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { IndexTabs } from "~/components/admin/resource/IndexTabs";
import { IndexPager } from "~/components/admin/data-table/DataTablePagination";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { MediaFilterBar, MediaGallery, MediaPreview, MediaUploadQueue } from "./components";
import { OptimizeImagesButton } from "./components/OptimizeImagesButton";
import type { useMediaManager } from "./hooks/useMediaManager";
import { canDeletePermanently, capabilityAccept, mediaLimitKey, type LibraryMediaFile, type MediaCapability, type MediaFile } from "./types";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import { matchesShortcut } from "../layout/shortcuts";

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
  const [confirm, setConfirm] = useState<{ action: "trash" | "permanent"; file?: LibraryMediaFile } | null>(null);
  const { cancelSelection, selectionMode, showPreview } = mm;
  const permissions = useMediaPermissions();
  const canUpload = permissions.upload && mm.view === "ready";
  const canManage = permissions.upload || permissions.delete || permissions.folders;
  const filtered = Boolean(mm.filters.search) || (capability === "both" && Boolean(mm.filters.kind)) || mm.currentFolderId !== "all";
  const pageStart = mm.pageIndex * mm.pageSize;
  const visibleFiles = mm.files.slice(pageStart, pageStart + mm.pageSize);
  const pageSelectableIds = visibleFiles.filter((file) => !mm.isFileUnavailable(file.id)).map((file) => file.id);
  const selectedIds = new Set(mm.selectedFileIds);
  const canSelectAllShown = pageSelectableIds.some((id) => !selectedIds.has(id));
  const hasLoadedNext = pageStart + mm.pageSize < mm.files.length;
  const busy = mm.isLoading || mm.isLoadingMore;
  const pager = mm.files.length > 0 && (mm.files.length > mm.pageSize || mm.hasMore) ? (
    <IndexPager
      label={r(mm.hasMore ? "showingCapped" : "showing", {
        start: pageStart + 1, end: pageStart + visibleFiles.length, total: mm.files.length,
      })}
      navLabel={r("pagination")}
      canPrevious={mm.pageIndex > 0}
      canNext={hasLoadedNext || mm.hasMore}
      onPrevious={() => { if (!busy) mm.setPageIndex(mm.pageIndex - 1); }}
      onNext={() => {
        if (busy) return;
        if (hasLoadedNext) mm.setPageIndex(mm.pageIndex + 1);
        else mm.loadMore();
      }}
    />
  ) : null;
  const usedSelected = mm.selectedLibraryFiles.filter((file) => file.usageCount > 0).length;
  const deletable = mm.selectedLibraryFiles.filter(canDeletePermanently);

  // Trashing an unused file is undoable from the toast; a used one asks first
  // because it keeps showing where it's used.
  const lifecycle = (file: LibraryMediaFile, action: Lifecycle) => {
    if (!(action === "restore" ? permissions.upload : permissions.delete)) return;
    if (action === "permanent" || (action === "trash" && file.usageCount > 0)) setConfirm({ action, file });
    else void mm.mutateOne(file, action);
  };
  const bulkLifecycle = (action: Lifecycle) => {
    if (!(action === "restore" ? permissions.upload : permissions.delete)) return;
    if (action === "permanent" && deletable.length > 0) setConfirm({ action });
    else if (action === "trash" && usedSelected > 0) setConfirm({ action });
    else void mm.mutateSelected(action);
  };

  /** Names the file when exactly one is affected; bulk copy counts the rest. */
  const confirmCopy = (() => {
    if (!confirm) return null;
    if (confirm.action === "permanent") {
      const one = confirm.file ?? (deletable.length === 1 ? deletable[0] : undefined);
      return {
        title: one ? t("deleteOneTitle", { name: one.filename }) : t("deleteManyTitle", { count: deletable.length }),
        description: t("deleteBody"),
        confirmLabel: r("deletePermanently"),
      };
    }
    const one = confirm.file ?? (mm.selectedLibraryFiles.length === 1 ? mm.selectedLibraryFiles[0] : undefined);
    return {
      title: one ? t("trashOneTitle", { name: one.filename }) : t("trashManyTitle", { count: mm.selectedFileIds.length }),
      description: one
        ? `${one.usageCount === 1 ? t("trashUsedOne") : t("trashUsedMany", { count: one.usageCount })} ${t("usedKeepsShowing")}`
        : `${t("trashUsedSome", { count: usedSelected })} ${t("trashUsedSomeHelp")}`,
      confirmLabel: r("moveToTrash"),
    };
  })();
  const navigate = (direction: -1 | 1) => {
    const index = mm.files.findIndex((file) => file.id === mm.previewFile?.id);
    const next = mm.files[index + direction];
    if (index >= 0 && next) mm.setPreviewFile(next);
  };

  useEffect(() => {
    if (picker || !selectionMode || showPreview || confirm) return;
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (!matchesShortcut("cancel", event) || event.defaultPrevented) return;
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
      {canUpload ? <input
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
      /> : null}
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
        canSelectAllShown={canSelectAllShown}
        selectionMode={mm.selectionMode}
        folders={mm.folders}
        currentFolderId={mm.currentFolderId}
        isMutating={mm.isMutating}
        allowSelection={picker ? multiple : canManage}
        allowManagement={!picker}
        onSearch={mm.applySearch}
        onClearFilters={mm.files.length > 0 ? mm.clearFilters : undefined}
        onFiltersChange={mm.applyFilters}
        onUploadClick={picker && canUpload ? () => inputRef.current?.click() : undefined}
        onFolderSelect={mm.moveToFolder}
        onFolderCreate={mm.createFolder}
        onFolderRename={mm.renameFolder}
        onFolderDelete={mm.deleteFolder}
        onBeginSelection={mm.beginSelection}
        onSelectAll={() => mm.selectAllVisible(pageSelectableIds)}
        onClearSelection={() => mm.clearSelection(true)}
        onCancelSelection={!picker ? mm.cancelSelection : undefined}
        onMove={(folderId) => { if (permissions.folders) void mm.moveSelected(folderId); }}
        onLifecycle={bulkLifecycle}
      />
      <MediaUploadQueue queue={mm.queue} onRetry={mm.retry} onDismiss={mm.dismiss} />
      <div className={picker ? "min-h-0 flex-1 overflow-y-auto" : undefined}>
        <MediaGallery
          files={mm.files}
          visibleFiles={visibleFiles}
          selectedFileIds={mm.selectedFileIds}
          isFileUnavailable={mm.isFileUnavailable}
          selectionMode={mm.selectionMode}
          allowManagement={!picker}
          view={mm.view}
          filtered={filtered}
          isLoading={mm.isLoading}
          isLoadingMore={mm.isLoadingMore}
          loadError={mm.loadError}
          onFileSelect={mm.handleFileSelect}
          onFilePreview={(file) => {
            mm.setPreviewFile(file);
            mm.setShowPreview(true);
          }}
          onToggleSelection={mm.toggleSelection}
          onLifecycle={lifecycle}
          onRetry={mm.retryFiles}
          onClearFilters={mm.clearFilters}
          onUploadClick={canUpload ? () => inputRef.current?.click() : undefined}
        />
      </div>
      {pager}
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
            {multiple ? <span className="me-auto text-body text-muted-foreground" aria-live="polite">{r("selected", { count: selected })}</span> : null}
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
          <PageHeader
            title={t("title")}
            actions={canUpload ? <OptimizeImagesButton onOptimized={() => void mm.refresh()} /> : null}
            primaryAction={canUpload ? (
              <Button type="button" onClick={() => inputRef.current?.click()}>
                <Upload aria-hidden="true" />{t("upload")}
              </Button>
            ) : null}
          />
          {!canManage ? <ReadOnlyNotice /> : null}
          <div className="overflow-hidden rounded-xl bg-card shadow-card">{body}</div>
        </>
      )}

      {!picker ? <UnsavedChangesGuard isDirty={mm.isUploading} isSubmitting={false} allowSamePathStateNavigation /> : null}
      <MediaPreview
        open={mm.showPreview}
        file={mm.previewFile}
        files={mm.files}
        onOpenChange={mm.setShowPreview}
        onNavigate={navigate}
        onUpdate={mm.updateFile}
        onReload={mm.fetchFile}
        onAdopt={mm.adoptFile}
        canEdit={permissions.update && mm.previewFile?.status === "ready"}
        onSelect={onSelect}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={confirmCopy?.title ?? ""}
        description={confirmCopy?.description ?? ""}
        confirmLabel={confirmCopy?.confirmLabel}
        variant={confirm?.action === "trash" ? "default" : "destructive"}
        cancelLabel={r("cancel")}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.file) void mm.mutateOne(confirm.file, confirm.action);
          else void mm.mutateSelected(confirm.action);
          setConfirm(null);
        }}
      />
    </div>
  );
}
