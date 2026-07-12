import React, { memo } from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ImageIcon,
  ImagePlus,
  Play,
  Plus,
  Settings2,
  Star,
  Trash2,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { MediaManager, type MediaFile } from "../media-manager";
import { cn } from "@scalius/shared/utils";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import type { ProductFormValues, ProductMediaItem } from "./types";

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

function selectedLibraryFiles(items: ProductMediaItem[]): MediaFile[] {
  return items.map((item) => ({
    id: item.mediaId,
    url: item.url,
    filename: item.effectiveAltText || item.mediaId,
    size: 0,
    createdAt: new Date(0),
    mimeType: item.kind === "video" ? "video/mp4" : "image/webp",
  }));
}

export const ProductImagesSection = memo(function ProductImagesSection({
  form,
}: {
  form: UseFormReturn<ProductFormValues>;
}) {
  const [isOpen, setIsOpen] = React.useState(true);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const mediaCount = form.watch("media")?.length ?? 0;

  const addMedia = React.useCallback((
    current: ProductMediaItem[],
    incoming: MediaFile[],
  ): ProductMediaItem[] => {
    const existingIds = new Set(current.map((item) => item.mediaId));
    const unique = incoming.filter((file) => !existingIds.has(file.id));
    const skipped = incoming.length - unique.length;
    if (skipped > 0) {
      toast.info(`${skipped} already attached ${skipped === 1 ? "asset was" : "assets were"} skipped.`);
    }
    const attached = unique.map((file, index) =>
      asProductMedia(file, current.length === 0 && index === 0, current.length + index),
    );
    return normalizeOrder([...current, ...attached]);
  }, []);

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={isOpen}
          aria-controls="product-media-content"
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", !isOpen && "-rotate-90")} />
          <CardTitle className="text-sm">Media{mediaCount ? ` (${mediaCount})` : ""}</CardTitle>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
            Choose one featured image or video
          </span>
        </button>
      </CardHeader>
      {isOpen ? (
        <CardContent id="product-media-content" className="px-4 pb-4 pt-0">
          <FormField
            control={form.control}
            name="media"
            render={({ field }) => (
              <FormItem>
                <div className="space-y-2.5">
                  {field.value.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
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
                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setShowAll((current) => !current)}>
                      {showAll ? "Show first 12" : `Manage all ${field.value.length} media items`}
                    </Button>
                  ) : null}
                  {editingId ? (
                    <MediaDetailsEditor
                      item={field.value.find((candidate) => candidate.id === editingId) ?? null}
                      onClose={() => setEditingId(null)}
                      onAltTextChange={(altText) => field.onChange(field.value.map((candidate) =>
                        candidate.id === editingId ? { ...candidate, altText } : candidate,
                      ))}
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <MediaManager
                      capability="both"
                      selectedFiles={selectedLibraryFiles(field.value)}
                      trigger={(
                        <Button type="button" variant="outline" size="sm" className="h-8 px-3 text-xs">
                          {field.value.length ? <Plus className="mr-1.5 h-3.5 w-3.5" /> : <ImagePlus className="mr-1.5 h-3.5 w-3.5" />}
                          {field.value.length ? "Add media" : "Choose media"}
                        </Button>
                      )}
                      onSelect={(file) => field.onChange(addMedia(field.value, [file]))}
                      onSelectMultiple={(files) => field.onChange(addMedia(field.value, files))}
                    />
                    <span className="text-xs text-muted-foreground">
                      Images may be assigned to SKUs. Videos remain gallery-only.
                    </span>
                  </div>
                  {field.value.length === 0 ? (
                    <div className="rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
                      Add images or videos from Media. Image-only surfaces use the featured image, a featured video poster, or the next usable image.
                    </div>
                  ) : null}
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      ) : null}
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
  const previewUrl = item.kind === "image" ? item.url : item.posterUrl;
  const duration = durationLabel(item.durationMs);
  return (
    <article className={cn("group overflow-hidden rounded-md border bg-background", item.status === "trashed" && "border-amber-300")}>
      <div className="relative aspect-square overflow-hidden bg-muted/30">
        {previewUrl ? (
          <img
            src={getOptimizedImageUrl(previewUrl)}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {item.kind === "video" ? <Video className="h-7 w-7" /> : <ImageIcon className="h-7 w-7" />}
          </div>
        )}
        <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
          <span className="rounded bg-background/90 px-1.5 py-0.5 text-xs font-medium shadow-sm">
            {item.kind === "video" ? "Video" : "Image"}
          </span>
          {item.isPrimary ? (
            <span className="rounded bg-foreground px-1.5 py-0.5 text-xs font-medium text-background shadow-sm">Featured</span>
          ) : null}
        </div>
        {item.kind === "video" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white shadow-sm"><Play className="ml-0.5 h-4 w-4 fill-current" /></span>
          </div>
        ) : null}
        {duration ? <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white">{duration}</span> : null}
      </div>
      <div className="space-y-1 p-1.5">
        <span className={cn("block truncate text-xs", item.kind === "video" && !item.posterUrl ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>
            {item.status === "trashed"
              ? "In trash · still attached"
              : item.kind === "video"
                ? item.posterUrl ? "Poster ready" : "No poster · image surfaces fall back"
                : `${item.width ?? "?"} × ${item.height ?? "?"}`}
        </span>
        <div className="flex items-center justify-between gap-0.5">
          <div className="flex items-center">
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${item.kind} earlier`}>
              <ArrowLeft className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move ${item.kind} later`}>
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center">
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label={`Edit ${item.kind} details`}>
              <Settings2 className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={item.isPrimary} onClick={onSetFeatured} aria-label={item.isPrimary ? "Featured media" : `Set ${item.kind} as featured`}>
              <Star className={cn("h-3.5 w-3.5", item.isPrimary && "fill-current")} />
            </Button>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={onRemove} aria-label={`Remove ${item.kind} from product`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

function MediaDetailsEditor({ item, onAltTextChange, onClose }: {
  item: ProductMediaItem | null;
  onAltTextChange: (value: string) => void;
  onClose: () => void;
}) {
  if (!item) return null;
  return (
    <div className="rounded-md border bg-muted/15 p-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium">Product-specific description</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Leave blank to use the Media description: {item.effectiveAltText || "No description saved"}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={onClose}>Done</Button>
      </div>
      <Input
        value={item.altText}
        onChange={(event) => onAltTextChange(event.target.value)}
        maxLength={500}
        aria-label={`Product-specific description for ${item.kind}`}
        placeholder="Use Media description"
        className="mt-2 h-8 px-2 text-xs"
      />
    </div>
  );
}
