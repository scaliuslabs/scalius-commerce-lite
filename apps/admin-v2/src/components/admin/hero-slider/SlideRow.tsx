import type { CSSProperties, ReactNode, Ref } from "react";
import { X, Type, Link as LinkIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import {
  HERO_SLIDE_PRESENTATION,
  getHeroSlideImageTransform,
  getHeroSlideObjectPosition,
} from "@scalius/shared/hero-slider";
import type { SliderImage } from "./helpers";
import { HeroFocalPointEditor } from "./HeroFocalPointEditor";

interface SlideRowProps {
  image: SliderImage;
  index: number;
  type: "desktop" | "mobile";
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<SliderImage>) => void;
  dragHandle?: ReactNode;
  isDragging?: boolean;
  rowRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
}

export function SlideRow({
  image,
  index,
  type,
  onRemove,
  onUpdate,
  dragHandle,
  isDragging = false,
  rowRef,
  style,
}: SlideRowProps) {
  const linkResult = parseNavigationHref(image.link);
  const titleMissing = image.title.trim().length === 0;
  const presentation = HERO_SLIDE_PRESENTATION[type];
  return (
    <div
      ref={rowRef}
      style={style}
      className={cn(
        "group relative flex flex-col gap-2 rounded-lg border bg-background p-2.5 shadow-xs transition-shadow hover:shadow-sm md:flex-row md:items-start",
        isDragging && "opacity-30 z-0 ring-2 ring-primary/20",
      )}
    >
      {dragHandle}

      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-md border bg-muted/30",
          type === "desktop"
            ? "w-full md:w-[180px]"
            : "w-full md:w-[132px]",
        )}
        style={{ aspectRatio: `${presentation.width} / ${presentation.height}` }}
      >
        <img
          src={getOptimizedImageUrl(
            image.url,
            getHeroSlideImageTransform(type, image.focalPoint, {
              width: 560,
              quality: 80,
            }),
          )}
          alt={image.title || "Slide"}
          className="h-full w-full object-cover"
          style={{ objectPosition: getHeroSlideObjectPosition(image.focalPoint) }}
          loading="lazy"
          decoding="async"
        />
        <div className="absolute inset-0 rounded-md ring-1 ring-inset ring-black/5" />
        <div className="absolute left-1.5 top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
          {index + 1}
        </div>
        <HeroFocalPointEditor
          imageId={image.id}
          imageUrl={image.url}
          imageText={image.title}
          focalPoint={image.focalPoint}
          onChange={(focalPoint) => onUpdate(image.id, { focalPoint })}
        />
      </div>

      <div className="grid min-w-0 flex-1 gap-2 lg:grid-cols-[minmax(180px,0.8fr)_minmax(260px,1.2fr)]">
        <div className="grid gap-1.5">
          <Label
            htmlFor={`title-${image.id}`}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <Type className="w-3.5 h-3.5" />
            Image text
          </Label>
          <Input
            id={`title-${image.id}`}
            value={image.title}
            onChange={(e) => onUpdate(image.id, { title: e.target.value })}
            placeholder="New season collection"
            aria-invalid={titleMissing}
            className="h-8 text-sm"
          />
          {titleMissing ? <p className="text-xs text-destructive">Describe this image for customers.</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor={`link-${image.id}`}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Destination <span className="font-normal opacity-70">(optional)</span>
          </Label>
          <Input
            id={`link-${image.id}`}
            value={image.link}
            onChange={(e) => onUpdate(image.id, { link: e.target.value })}
            placeholder="/collections/new or https://example.com"
            aria-invalid={!linkResult.ok}
            className="h-8 bg-muted/15 text-sm focus:bg-background"
          />
          {!linkResult.ok ? <p className="text-xs text-destructive">{linkResult.reason}</p> : null}
        </div>
      </div>

      <div className="flex items-center justify-end border-t pt-2 md:border-l md:border-t-0 md:pl-2 md:pt-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          onClick={() => onRemove(image.id)}
          title={`Remove slide ${index + 1}`}
          aria-label={`Remove slide ${index + 1}`}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
