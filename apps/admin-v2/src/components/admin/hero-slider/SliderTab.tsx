import { lazy, Suspense, useMemo } from "react";
import {
  AlertTriangle,
  Image as ImageIcon,
  Loader2,
  Plus,
  RotateCcw,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import {
  HERO_SLIDE_LIMIT,
  HERO_SLIDE_DEFAULT_FOCAL_POINT,
  HERO_SLIDE_PRESENTATION,
  validateAndNormalizeHeroSlides,
} from "@scalius/shared/hero-slider";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Switch } from "~/components/ui/switch";
import { Badge } from "~/components/ui/badge";
import { MediaManager } from "../media-manager";
import type { HeroSlider, SliderImage, MediaFile } from "./helpers";
import { generateImageId } from "./helpers";

const SortableSlidesEditor = lazy(() =>
  import("./SortableSlidesEditor").then((module) => ({
    default: module.SortableSlidesEditor,
  })),
);

interface SliderTabProps {
  type: "desktop" | "mobile";
  slider: HeroSlider | null;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  onCreate: (type: "desktop" | "mobile") => void;
  onChange: (slider: HeroSlider) => void;
  onSave: () => void;
  onDiscard: () => void;
  onLoadLatest: () => void;
}

export function SliderTab({
  type,
  slider,
  dirty,
  saving,
  conflict,
  onCreate,
  onChange,
  onSave,
  onDiscard,
  onLoadLatest,
}: SliderTabProps) {
  const validation = useMemo(
    () => validateAndNormalizeHeroSlides(slider?.images ?? []),
    [slider?.images],
  );
  const issues = [
    ...(slider?.isActive && slider.images.length === 0
      ? ["Add at least one slide before showing this hero."]
      : []),
    ...(validation.ok ? [] : validation.errors),
  ];
  const presentation = HERO_SLIDE_PRESENTATION[type];

  if (!slider) {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center rounded-lg border border-dashed bg-muted/10 px-6 text-center">
        <div className="mb-3 rounded-lg border bg-background p-2.5">
          <ImageIcon className="h-5 w-5 text-muted-foreground" />
        </div>
        <h2 className="text-sm font-semibold">No {type} hero yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Create an inactive draft, add its banner images, then turn it on when it is ready.
        </p>
        <Button className="mt-4" size="sm" onClick={() => onCreate(type)} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
          Create {type} hero
        </Button>
      </div>
    );
  }

  const updateImage = (imageId: string, updates: Partial<SliderImage>) => {
    onChange({
      ...slider,
      images: slider.images.map((image) =>
        image.id === imageId ? { ...image, ...updates } : image,
      ),
    });
  };

  const addImages = (files: MediaFile[]) => {
    const remaining = HERO_SLIDE_LIMIT - slider.images.length;
    if (remaining <= 0) {
      toast.error(`A hero can contain at most ${HERO_SLIDE_LIMIT} slides.`);
      return;
    }
    const accepted = files.slice(0, remaining);
    if (accepted.length < files.length) {
      toast.warning(`Only ${accepted.length} image${accepted.length === 1 ? "" : "s"} added`, {
        description: `A hero can contain at most ${HERO_SLIDE_LIMIT} slides.`,
      });
    }
    onChange({
      ...slider,
      images: [
        ...slider.images,
        ...accepted.map((file) => ({
          id: generateImageId(),
          url: file.url,
          title: file.altText?.trim() || file.filename,
          link: "",
          focalPoint: { ...HERO_SLIDE_DEFAULT_FOCAL_POINT },
        })),
      ],
    });
  };

  const removeImage = (imageId: string) => {
    onChange({
      ...slider,
      images: slider.images.filter((image) => image.id !== imageId),
    });
  };

  return (
    <div className="space-y-3">
      {conflict ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-sm font-medium">A newer saved version exists</p>
              <p className="text-xs opacity-80">Your local draft is preserved. Loading latest replaces it.</p>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={onLoadLatest} disabled={saving}>
            Load latest
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/15 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex min-h-11 items-center gap-2 sm:min-h-0">
            <Switch
              id={`${type}-active`}
              checked={slider.isActive}
              onCheckedChange={(isActive) => onChange({ ...slider, isActive })}
            />
            <Label htmlFor={`${type}-active`} className="cursor-pointer text-sm">
              {slider.isActive ? "Visible on storefront" : "Hidden from storefront"}
            </Label>
          </div>
          <span className="hidden h-4 w-px bg-border sm:block" />
          <span className="text-xs text-muted-foreground">
            Target {presentation.width} × {presentation.height} · focus controls the crop
          </span>
          <Badge variant="outline" className="h-5 font-normal">
            {slider.images.length}/{HERO_SLIDE_LIMIT} slides
          </Badge>
        </div>
        <MediaManager
          capability="image"
          onSelect={(file) => addImages([file])}
          onSelectMultiple={addImages}
          trigger={
            <Button
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={slider.images.length >= HERO_SLIDE_LIMIT}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add slides
            </Button>
          }
        />
      </div>

      {issues.length > 0 ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <p className="font-medium">Fix before saving</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {issues.slice(0, 4).map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </div>
      ) : null}

      {slider.images.length === 0 ? (
        <div className="flex min-h-40 w-full flex-col items-center justify-center rounded-lg border border-dashed bg-muted/10 px-6 text-center">
          <ImageIcon className="h-5 w-5 text-muted-foreground" />
          <span className="mt-2 text-sm font-medium">Add the first banner image</span>
          <span className="mt-1 text-xs text-muted-foreground">Use concise descriptive text; a destination is optional.</span>
        </div>
      ) : (
        <Suspense fallback={<SlideListFallback count={slider.images.length} />}>
          <SortableSlidesEditor
            type={type}
            slider={slider}
            onUpdateImageLocal={(_, id, updates) => updateImage(id, updates)}
            onRemove={removeImage}
            setSlider={onChange}
          />
        </Suspense>
      )}

      {dirty || saving ? (
        <div className="sticky bottom-3 z-20 flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />
            <span>{saving ? "Saving…" : "Unsaved changes"}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1 sm:gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 px-2 sm:min-h-9 sm:px-3"
              onClick={onDiscard}
              disabled={saving}
            >
              <RotateCcw className="mr-1 h-4 w-4 sm:mr-2" />
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              className="min-h-11 px-2 sm:min-h-9 sm:px-3"
              onClick={onSave}
              disabled={saving || conflict || issues.length > 0}
            >
              {saving ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin sm:mr-2" />
              ) : (
                <Save className="mr-1 h-4 w-4 sm:mr-2" />
              )}
              <span className="sm:hidden">Save</span>
              <span className="hidden sm:inline">Save changes</span>
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SlideListFallback({ count }: { count: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="h-24 animate-pulse rounded-lg border bg-muted/20" />
      ))}
    </div>
  );
}
