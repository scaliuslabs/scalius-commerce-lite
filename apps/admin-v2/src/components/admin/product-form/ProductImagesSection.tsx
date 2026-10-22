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
import { toast } from "~/lib/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormField } from "@/components/ui/form";
import { MediaManager, type MediaFile } from "../media-manager";
import { cn } from "@scalius/shared/utils";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { translate, useMessages } from "~/i18n";
import { productMediaMessages } from "~/i18n/product-media";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues, ProductMediaItem } from "./types";
import { Field, FieldAction } from "~/components/ui/field";

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
    filename: file.filename,
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

/** View-only staff see the media without any edit controls, as Shopify does. */
/** The first item is the main one: the badge and the storefront's cover never disagree with the order. */
function firstIsMain<T extends { isPrimary: boolean }>(items: T[]): T[] {
  return items.map((candidate, position) => ({ ...candidate, isPrimary: position === 0 }));
}

export const ProductImagesSection = memo(function ProductImagesSection({
  form,
  readOnly = false,
}: {
  form: UseFormReturn<ProductFormValues>;
  readOnly?: boolean;
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
          render={({ field, fieldState }) => (
            <Field error={fieldState.error?.message}>
              <div className="space-y-3">
                {field.value.length > 0 ? (
                  <div className={cn("grid gap-2 sm:grid-cols-3 lg:grid-cols-4", readOnly ? "grid-cols-3" : "grid-cols-1")}>
                    {(showAll ? field.value : field.value.slice(0, 12)).map((item, index) => (
                      <ProductMediaTile
                        key={item.id}
                        item={item}
                        index={index}
                        count={field.value.length}
                        readOnly={readOnly}
                        onMove={(direction) => {
                          const target = index + direction;
                          if (target < 0 || target >= field.value.length) return;
                          const next = [...field.value];
                          [next[index], next[target]] = [next[target]!, next[index]!];
                          field.onChange(normalizeOrder(firstIsMain(next)));
                        }}
                        // The main item is the first one (Shopify's model): making one main moves it first.
                        onSetFeatured={() => field.onChange(normalizeOrder(firstIsMain([
                          item,
                          ...field.value.filter((candidate) => candidate.id !== item.id),
                        ])))}
                        onEdit={() => setEditingId(item.id)}
                        onRemove={() => {
                          const remaining = field.value.filter((candidate) => candidate.id !== item.id);
                          field.onChange(normalizeOrder(item.isPrimary || field.value[0]?.isPrimary ? firstIsMain(remaining) : remaining));
                          if (editingId === item.id) setEditingId(null);
                        }}
                      />
                    ))}
                  </div>
                ) : readOnly ? (
                  <p className="text-body text-muted-foreground">{t("noMedia")}</p>
                ) : null}
                {field.value.length > 12 ? (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((current) => !current)}>
                    {showAll ? t("showFewerMedia") : t("showAllMedia", { count: field.value.length })}
                  </Button>
                ) : null}
                {!readOnly && editingId ? (
                  <MediaDetailsEditor
                    item={field.value.find((candidate) => candidate.id === editingId) ?? null}
                    index={field.value.findIndex((candidate) => candidate.id === editingId)}
                    count={field.value.length}
                    productName={form.getValues("name") ?? ""}
                    onClose={() => setEditingId(null)}
                    onAltTextChange={(altText) => field.onChange(field.value.map((candidate) =>
                      candidate.id === editingId ? { ...candidate, altText } : candidate,
                    ))}
                  />
                ) : null}
                {readOnly ? null : <MediaManager
                  capability="both"
                  unavailableFileIds={attachedMediaIds}
                  trigger={(
                    <Button type="button" variant="outline" size="sm">
                      <ImagePlus className="me-2 h-4 w-4" />
                      {t("addMedia")}
                    </Button>
                  )}
                  onSelect={(file) => field.onChange(addMedia(field.value, [file]))}
                  onSelectMultiple={(files) => field.onChange(addMedia(field.value, files))}
                />}
              </div>
            </Field>
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
  readOnly,
  onMove,
  onSetFeatured,
  onEdit,
  onRemove,
}: {
  item: ProductMediaItem;
  index: number;
  count: number;
  readOnly: boolean;
  onMove: (direction: -1 | 1) => void;
  onSetFeatured: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useMessages(productMessages);
  const m = useMessages(productMediaMessages);
  const isVideo = item.kind === "video";
  const position = positionLabel(m, item, index, count);
  // The product's own description when set, else the file's name: never the
  // product title, which every photo would share after a reload.
  const name = item.altText.trim() || item.filename || item.effectiveAltText;
  const named = m("named", { item: position, name });
  const previewUrl = item.kind === "image" ? item.url : item.posterUrl;
  const duration = durationLabel(item.durationMs);
  const note = item.status === "trashed"
    ? t("mediaInTrash")
    : item.kind === "video" && !item.posterUrl
      ? t("videoNoCover")
      : null;
  return (
    <article aria-label={named} className={readOnly ? "space-y-1" : "grid grid-cols-3 gap-2 sm:block sm:space-y-1"}>
      <div className={cn("relative aspect-square overflow-hidden rounded-md border bg-muted", item.status === "trashed" && "border-destructive")}>
        {previewUrl ? (
          <img
            src={mediaImageUrl(previewUrl, 320)}
            alt={name}
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
          // The near-black frame colour in both themes: product photos are mostly white, and a theme-flipped chip vanishes on them in dark mode.
          <span className="absolute inset-s-1.5 top-1.5 rounded-sm bg-sidebar px-1.5 text-body font-medium text-sidebar-foreground">
            {t("mainMedia")}
          </span>
        ) : null}
        {item.kind === "video" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-foreground text-background">
              <Play className="ms-0.5 h-4 w-4 fill-current" />
            </span>
          </div>
        ) : null}
        {duration ? (
          <span className="absolute bottom-1.5 inset-e-1.5 rounded-sm bg-foreground px-1.5 text-body text-background">
            {duration}
          </span>
        ) : null}
      </div>
      <div className="col-span-2 min-w-0 space-y-1">
        {note ? <span className="block truncate text-body text-destructive">{note}</span> : null}
        {readOnly ? null : <div className="flex flex-wrap items-center justify-between gap-1">
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
        </div>}
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

function MediaDetailsEditor({ item, index, count, productName, onAltTextChange, onClose }: {
  item: ProductMediaItem | null;
  /** What buyers' screen readers hear when no description is set: the product's title. */
  productName: string;
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
    <div className="border-t pt-3">
      <Field
        id={id}
        label={m("descriptionFor", { item: positionLabel(m, item, index, count) })}
        help={m("descriptionHint")}
        labelAction={<FieldAction onClick={onClose}>{t("done")}</FieldAction>}
      >
        <Input
          autoFocus
          value={item.altText}
          onChange={(event) => onAltTextChange(event.target.value)}
          maxLength={500}
          // An example of what shows without a description: never the file name (F6).
          placeholder={(item.effectiveAltText && item.effectiveAltText !== item.filename ? item.effectiveAltText : productName) || undefined}
        />
      </Field>
    </div>
  );
}
