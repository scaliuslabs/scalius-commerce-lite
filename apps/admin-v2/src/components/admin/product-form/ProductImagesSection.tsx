import React, { memo } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import {
  ArrowLeft,
  ArrowRight,
  ImageIcon,
  ImagePlus,
  PenLine,
  Play,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { MediaManager, type MediaFile } from "../media-manager";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { translate, useMessages } from "~/i18n";
import { productMediaMessages } from "~/i18n/media";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues, ProductMediaItem } from "./types";

const EMPTY_PRODUCT_MEDIA: ProductMediaItem[] = [];

function associationId(): string {
  return `pmed_${crypto.randomUUID().replaceAll("-", "")}`;
}
function durationLabel(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function asProductMedia(file: MediaFile, primary: boolean, sortOrder: number): ProductMediaItem {
  const libraryFile = file as MediaFile & {
    kind?: "image" | "video";
    posterMediaId?: string | null;
    posterUrl?: string | null;
    caption?: string | null;
    durationMs?: number | null;
    status?: "ready" | "trashed" | "deleting" | "deleted";
  };
  const kind = libraryFile.kind ?? (file.mimeType?.startsWith("video/") ? "video" : "image");
  return {
    id: associationId(),
    mediaId: file.id,
    kind,
    url: file.url,
    posterMediaId: libraryFile.posterMediaId ?? null,
    posterUrl: libraryFile.posterUrl ?? null,
    effectiveAltText: libraryFile.altText?.trim() || file.filename,
    altText: "",
    caption: libraryFile.caption ?? null,
    width: libraryFile.width ?? null,
    height: libraryFile.height ?? null,
    durationMs: libraryFile.durationMs ?? null,
    isPrimary: primary,
    sortOrder,
    status: libraryFile.status === "trashed" ? "trashed" : "ready",
  };
}

function normalizeOrder(items: ProductMediaItem[]): ProductMediaItem[] {
  return items.map((item, sortOrder) => ({ ...item, sortOrder }));
}

export const ProductImagesSection = memo(function ProductImagesSection({
  form,
}: {
  form: UseFormReturn<ProductFormValues>;
}) {
  const t = useMessages(productMessages);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const mediaItems = useWatch({ control: form.control, name: "media" }) ?? EMPTY_PRODUCT_MEDIA;
  const attachedMediaIds = React.useMemo(
    () => mediaItems.map((item) => item.mediaId),
    [mediaItems],
  );

  const addMedia = React.useCallback((
    current: ProductMediaItem[],
    incoming: MediaFile[],
  ): ProductMediaItem[] => {
    const existingIds = new Set(current.map((item) => item.mediaId));
    const unique = incoming.filter((file) => !existingIds.has(file.id));
    const skipped = incoming.length - unique.length;
    if (skipped > 0) toast.info(translate(productMessages, "mediaSkipped", { count: skipped }));
    const attached = unique.map((file, index) =>
      asProductMedia(file, current.length === 0 && index === 0, current.length + index),
    );
    return normalizeOrder([...current, ...attached]);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("media")}</CardTitle>
      </CardHeader>
      <CardContent>
        <FormField
          control={form.control}
          name="media"
          render={({ field }) => (
            <FormItem>
              <div className="space-y-3">
                {field.value.length > 0 ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {(showAll ? field.value : field.value.slice(0, 12)).map((item, index) => (
                      <ProductMediaTile
                        key={item.id}
                        item={item}
                        index={index}
                        count={field.value.length}
                        onMove={(direction) => {
                          const target = index + direction;
                          if (target < 0 || target >= field.value.length) return;
                          const next = [...field.value];
                          [next[index], next[target]] = [next[target]!, next[index]!];
                          field.onChange(normalizeOrder(next));
                        }}
                        onSetFeatured={() => field.onChange(field.value.map((candidate) => ({
                          ...candidate,
                          isPrimary: candidate.id === item.id,
                        })))}
                        onEdit={() => setEditingId(item.id)}
                        onRemove={() => {
                          const remaining = field.value.filter((candidate) => candidate.id !== item.id);
                          const needsPrimary = item.isPrimary && remaining.length > 0;
                          field.onChange(normalizeOrder(remaining.map((candidate, remainingIndex) => ({
                            ...candidate,
                            isPrimary: needsPrimary ? remainingIndex === 0 : candidate.isPrimary,
                          }))));
                          if (editingId === item.id) setEditingId(null);
                        }}
                      />
                    ))}
                  </div>
                ) : null}
                {field.value.length > 12 ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((current) => !current)}>
                    {showAll ? t("showFewerMedia") : t("showAllMedia", { count: field.value.length })}
                  </Button>
                ) : null}
                {editingId ? (
                  <MediaDetailsEditor
                    item={field.value.find((candidate) => candidate.id === editingId) ?? null}
                    index={field.value.findIndex((candidate) => candidate.id === editingId)}
                    count={field.value.length}
                    onClose={() => setEditingId(null)}
                    onAltTextChange={(altText) => field.onChange(field.value.map((candidate) =>
                      candidate.id === editingId ? { ...candidate, altText } : candidate,
                    ))}
                  />
                ) : null}
                <MediaManager
                  capability="both"
                  unavailableFileIds={attachedMediaIds}
                  trigger={(
                    <Button type="button" variant="outline" size="sm">
                      <ImagePlus className="mr-2 h-4 w-4" />
                      {t("addMedia")}
                    </Button>
                  )}
                  onSelect={(file) => field.onChange(addMedia(field.value, [file]))}
                  onSelectMultiple={(files) => field.onChange(addMedia(field.value, files))}
                />
              </div>
              <FormMessage />
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
});

function ProductMediaTile({
  item,
  index,
  count,
  onMove,
  onSetFeatured,
  onEdit,
  onRemove,
}: {
  item: ProductMediaItem;
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onSetFeatured: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useMessages(productMessages);
  const m = useMessages(productMediaMessages);
  const isVideo = item.kind === "video";
  const position = positionLabel(m, item, index, count);
  const named = m("named", { item: position, name: item.effectiveAltText });
  const previewUrl = item.kind === "image" ? item.url : item.posterUrl;
  const duration = durationLabel(item.durationMs);
  const note = item.status === "trashed"
    ? t("mediaInTrash")
    : item.kind === "video" && !item.posterUrl
      ? t("videoNoCover")
      : null;
  return (
    <article aria-label={named} className="grid grid-cols-3 gap-2 sm:block sm:space-y-1">
      <div className={cn("relative aspect-square overflow-hidden rounded-md border bg-muted", item.status === "trashed" && "border-destructive")}>
        {previewUrl ? (
          <img
            src={mediaImageUrl(previewUrl, 320)}
            alt=""
            className="h-full w-full object-contain object-center"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {item.kind === "video" ? <Video className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
          </div>
        )}
        {item.isPrimary ? (
          <span className="absolute left-1.5 top-1.5 rounded-sm bg-foreground px-1.5 text-body font-medium text-background">
            {t("mainMedia")}
          </span>
        ) : null}
        {item.kind === "video" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background">
              <Play className="ml-0.5 h-4 w-4 fill-current" />
            </span>
          </div>
        ) : null}
        {duration ? (
          <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-foreground px-1.5 text-body text-background">
            {duration}
          </span>
        ) : null}
      </div>
      <div className="col-span-2 min-w-0 space-y-1">
        {note ? <span className="block truncate text-body text-destructive">{note}</span> : null}
        <div className="flex flex-wrap items-center justify-between gap-1">
          <div className="flex items-center">
            <TileAction tip={m("moveEarlier")} label={m("moveEarlierItem", { item: position })} disabled={index === 0} onClick={() => onMove(-1)}>
              <ArrowLeft />
            </TileAction>
            <TileAction tip={m("moveLater")} label={m("moveLaterItem", { item: position })} disabled={index === count - 1} onClick={() => onMove(1)}>
              <ArrowRight />
            </TileAction>
          </div>
          <div className="flex items-center">
            <TileAction tip={m("editDescription")} label={m("editDescriptionItem", { item: position })} onClick={onEdit}>
              <PenLine />
            </TileAction>
            <TileAction
              tip={m(isVideo ? "makeMainVideo" : "makeMainPhoto")}
              label={m(isVideo ? "makeMainVideoItem" : "makeMainPhotoItem", { item: position })}
              disabled={item.isPrimary}
              onClick={onSetFeatured}
            >
              <Star className={cn(item.isPrimary && "fill-current")} />
            </TileAction>
            <TileAction tip={m("remove")} label={m("removeItem", { item: named })} onClick={onRemove}>
              <Trash2 />
            </TileAction>
          </div>
        </div>
      </div>
    </article>
  );
}

/** Icon button whose accessible name names the item; the tooltip shows the short verb. */
function TileAction({ tip, label, disabled, onClick, children }: {
  tip: string;
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" disabled={disabled} onClick={onClick} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}

/** "Photo 2 of 3" / "Video 2 of 3". */
type MediaText = (key: keyof typeof productMediaMessages.en, vars?: Record<string, string | number>) => string;
function positionLabel(m: MediaText, item: ProductMediaItem, index: number, count: number) {
  return m(item.kind === "video" ? "videoAt" : "photoAt", { position: index + 1, count });
}

function MediaDetailsEditor({ item, index, count, onAltTextChange, onClose }: {
  item: ProductMediaItem | null;
  index: number;
  count: number;
  onAltTextChange: (value: string) => void;
  onClose: () => void;
}) {
  const t = useMessages(productMessages);
  const m = useMessages(productMediaMessages);
  const id = React.useId();
  if (!item) return null;
  return (
    <div className="space-y-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{m("descriptionFor", { item: positionLabel(m, item, index, count) })}</Label>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t("done")}</Button>
      </div>
      <Input
        id={id}
        autoFocus
        value={item.altText}
        onChange={(event) => onAltTextChange(event.target.value)}
        maxLength={500}
        placeholder={item.effectiveAltText}
      />
      <p className="text-body text-muted-foreground">{m("descriptionHint")}</p>
    </div>
  );
}
