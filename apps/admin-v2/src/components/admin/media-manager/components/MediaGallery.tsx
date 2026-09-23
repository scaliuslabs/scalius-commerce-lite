import type { MouseEvent } from "react";
import { AlertCircle, ImageIcon, SearchX, Trash2, Upload } from "lucide-react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { EmptyState } from "~/components/admin/resource/EmptyState";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import { MediaCard } from "./MediaCard";
import type { LibraryMediaFile, MediaLibraryView } from "../types";
import { resolveSavedPoster } from "../utils/poster";

interface MediaGalleryProps {
  files: LibraryMediaFile[];
  selectedFileIds: string[];
  isFileUnavailable: (id: string) => boolean;
  selectionMode: boolean;
  allowManagement: boolean;
  view: MediaLibraryView;
  /** Search, type or folder narrows the list (drives the "no matches" empty state). */
  filtered: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadError: string | null;
  onFileSelect: (file: LibraryMediaFile, extendRange?: boolean) => void;
  onFilePreview: (file: LibraryMediaFile) => void;
  onToggleSelection: (id: string, extendRange?: boolean) => void;
  onLifecycle: (file: LibraryMediaFile, action: "trash" | "restore" | "permanent") => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onClearFilters: () => void;
  onUploadClick?: () => void;
}

const GRID = "grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

export function MediaGallery(props: MediaGalleryProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);

  if (props.isLoading && !props.files.length) {
    return (
      <div className={GRID} role="status" aria-busy="true" aria-label={r("loading")}>
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="aspect-4/3" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ))}
      </div>
    );
  }

  if (!props.files.length) {
    if (props.loadError) {
      return (
        <div role="alert">
          <EmptyState
            icon={AlertCircle}
            title={t("loadFailed")}
            description={props.loadError}
            action={<Button type="button" variant="outline" onClick={props.onRetry}>{r("retry")}</Button>}
          />
        </div>
      );
    }
    if (props.view === "trash") return <EmptyState icon={Trash2} title={r("trashEmpty")} description={t("trashEmptyBody")} />;
    if (props.filtered) {
      return (
        <EmptyState
          icon={SearchX}
          title={t("noMatches")}
          description={r("noResultsHint")}
          action={<Button type="button" variant="outline" onClick={props.onClearFilters}>{r("clearFilters")}</Button>}
        />
      );
    }
    return (
      <EmptyState
        icon={ImageIcon}
        title={t("emptyTitle")}
        description={t("emptyBody")}
        action={props.onUploadClick ? (
          <Button type="button" onClick={props.onUploadClick}>
            <Upload aria-hidden="true" />
            {t("upload")}
          </Button>
        ) : undefined}
      />
    );
  }

  return (
    <>
      {props.loadError ? (
        <Alert variant="warning" className="mx-3 mt-3 w-auto">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {t("refreshFailed")}
              <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>{r("retry")}</Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className={GRID} role="list" aria-label={props.view === "trash" ? r("trash") : t("title")}>
        {props.files.map((file) => (
          <MediaCard
            key={file.id}
            file={file}
            posterUrl={resolveSavedPoster(file, props.files).posterUrl}
            selected={props.selectedFileIds.includes(file.id)}
            unavailable={props.isFileUnavailable(file.id)}
            selectionMode={props.selectionMode}
            allowManagement={props.allowManagement}
            view={props.view}
            onActivate={(event) => props.onFileSelect(file, event.shiftKey)}
            onPreview={(event: MouseEvent) => {
              event.stopPropagation();
              props.onFilePreview(file);
            }}
            onToggle={(event) => props.onToggleSelection(file.id, event.shiftKey)}
            onLifecycle={(action) => props.onLifecycle(file, action)}
          />
        ))}
      </div>
      {props.hasMore ? (
        <div className="flex justify-center pb-4">
          <Button type="button" variant="outline" loading={props.isLoadingMore} onClick={props.onLoadMore}>{t("loadMore")}</Button>
        </div>
      ) : null}
    </>
  );
}
