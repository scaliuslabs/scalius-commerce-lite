import { useState, type MouseEvent } from "react";
import { Check, Eye, ImageOff, MoreHorizontal, Play, RotateCcw, Trash2 } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { resourceMessages } from "~/i18n/resource";
import { canDeletePermanently, type LibraryMediaFile, type MediaLibraryView } from "../types";
import { formatDuration, formatFileSize, formatFileType } from "../utils";

interface MediaCardProps {
  file: LibraryMediaFile;
  posterUrl?: string | null;
  selected: boolean;
  unavailable?: boolean;
  selectionMode: boolean;
  allowManagement: boolean;
  view: MediaLibraryView;
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
  onPreview: (event: MouseEvent) => void;
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void;
  onLifecycle: (action: "trash" | "restore" | "permanent") => void;
}

/** One file tile: pre-generated WebP thumbnail, name and size; selected tiles get the focus-blue ring. */
export function MediaCard({ file, posterUrl, selected, unavailable = false, selectionMode, allowManagement, view, onActivate, onPreview, onToggle, onLifecycle }: MediaCardProps) {
  const t = useMessages(mediaMessages);
  const r = useMessages(resourceMessages);
  const [loadFailed, setLoadFailed] = useState(false);
  const isImage = file.kind === "image";
  const extra = formatDuration(file.durationMs) ?? (file.width && file.height ? `${file.width} × ${file.height}` : null);
  const previewUrl = isImage ? mediaImageUrl(file.url, 480) : posterUrl ? mediaImageUrl(posterUrl, 480) : null;
  const deletable = canDeletePermanently(file);
  // Ready files say where they're used; in Trash a file still in use says why it can't be deleted.
  const usage = view === "trash"
    ? file.usageCount > 0 ? t("inUseKept") : file.keptForOrders ? t("keptForOrders") : null
    : file.usageCount === 1 ? t("usedInOne") : file.usageCount > 1 ? t("usedInMany", { count: file.usageCount }) : null;
  const label = unavailable
    ? t("alreadyAdded", { name: file.filename })
    : selectionMode
      ? t(selected ? "deselectFile" : "selectFile", { name: file.filename })
      : t("openFile", { name: file.filename });

  return (
    <article
      role="listitem"
      className={cn(
        "group relative overflow-hidden rounded-lg border bg-card hover:border-muted-foreground",
        selected && "border-ring ring-2 ring-ring",
        unavailable && "opacity-50",
      )}
    >
      <button
        type="button"
        disabled={unavailable}
        className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={selectionMode ? onToggle : onActivate}
        aria-pressed={selectionMode && !unavailable ? selected : undefined}
        aria-keyshortcuts={selectionMode && !unavailable ? "Shift+Enter" : undefined}
        aria-label={label}
        title={selectionMode && !unavailable ? t("rangeHint") : undefined}
      >
        <div className="relative flex aspect-4/3 items-center justify-center overflow-hidden bg-muted text-muted-foreground">
          {previewUrl && !loadFailed ? (
            <img
              src={previewUrl}
              alt={isImage ? file.altText || file.filename : ""}
              className="size-full object-contain"
              loading="lazy"
              decoding="async"
              onError={() => setLoadFailed(true)}
            />
          ) : file.kind === "video" ? (
            <Play className="size-8" aria-hidden="true" />
          ) : (
            <ImageOff className="size-6" aria-label={t("noPreview")} />
          )}
          {file.kind === "video" ? (
            <Badge className="absolute bottom-2 left-2">
              <Play aria-hidden="true" />
              {t("video")}
            </Badge>
          ) : null}
          {selectionMode && unavailable ? (
            <Badge className="absolute left-2 top-2">{t("added")}</Badge>
          ) : selectionMode ? (
            <span
              aria-hidden="true"
              className={cn(
                "absolute left-2 top-2 flex size-5 items-center justify-center rounded-md border border-input bg-card",
                selected && "border-primary bg-primary text-primary-foreground",
              )}
            >
              {selected ? <Check className="size-3.5" /> : null}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col px-2.5 py-2 group-hover:bg-accent">
          <span className="truncate text-body font-medium" title={file.filename}>{file.filename}</span>
          <span className="truncate text-body text-muted-foreground">
            {[formatFileType(file.mimeType).replace(/ (Image|Video)$/, ""), formatFileSize(file.size), extra].filter(Boolean).join(" · ")}
          </span>
          {usage ? <span className="text-body text-muted-foreground">{usage}</span> : null}
        </div>
      </button>

      {!selectionMode ? (
        <div className="absolute right-1.5 top-1.5 flex gap-1">
          <Button type="button" variant="outline" size="icon-sm" onClick={onPreview} aria-label={t("previewFile", { name: file.filename })}>
            <Eye aria-hidden="true" />
          </Button>
          {allowManagement ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon-sm" onClick={(event) => event.stopPropagation()} aria-label={r("actionsFor", { name: file.filename })}>
                  <MoreHorizontal aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {view === "ready" ? (
                  <DropdownMenuItem onSelect={() => onLifecycle("trash")}>
                    <Trash2 aria-hidden="true" />
                    {r("moveToTrash")}
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => onLifecycle("restore")}>
                      <RotateCcw aria-hidden="true" />
                      {r("restore")}
                    </DropdownMenuItem>
                    {deletable ? (
                      <DropdownMenuItem variant="destructive" onSelect={() => onLifecycle("permanent")}>
                        <Trash2 aria-hidden="true" />
                        {r("deletePermanently")}
                      </DropdownMenuItem>
                    ) : null}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
