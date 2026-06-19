import type { CSSProperties, ReactNode, Ref } from "react";
import { X, Type, Link as LinkIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import type { SliderImage } from "./helpers";

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
  return (
    <div
      ref={rowRef}
      style={style}
      className={cn(
        "group relative flex flex-col md:flex-row gap-4 p-4 rounded-xl border bg-card text-card-foreground shadow-xs transition-all hover:shadow-md",
        isDragging && "opacity-30 z-0 ring-2 ring-primary/20",
        "bg-background",
      )}
    >
      {dragHandle}

      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-lg border bg-muted/30",
          type === "desktop"
            ? "aspect-16/5 w-full md:w-[280px]"
            : "aspect-16/5 w-full md:w-[200px]",
        )}
      >
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.title || "Slide"}
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
        />
        <div className="absolute inset-0 ring-1 ring-inset ring-black/5 rounded-lg" />
        <div className="absolute top-2 left-2 bg-black/60 backdrop-blur-sm text-white text-[10px] px-2 py-0.5 rounded-full font-medium">
          Slide {index + 1}
        </div>
      </div>

      <div className="flex-1 grid gap-4">
        <div className="grid gap-1.5">
          <Label
            htmlFor={`title-${image.id}`}
            className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"
          >
            <Type className="w-3.5 h-3.5" />
            Title / Alt Text
          </Label>
          <Input
            id={`title-${image.id}`}
            value={image.title}
            onChange={(e) => onUpdate(image.id, { title: e.target.value })}
            placeholder="e.g. Summer Sale Collection"
            className="h-9 transition-colors focus-visible:ring-primary/20"
          />
        </div>
        <div className="grid gap-1.5">
          <Label
            htmlFor={`link-${image.id}`}
            className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Destination URL
          </Label>
          <Input
            id={`link-${image.id}`}
            value={image.link}
            onChange={(e) => onUpdate(image.id, { link: e.target.value })}
            placeholder="e.g. /collections/summer-sale"
            className="h-9 transition-colors focus-visible:ring-primary/20 bg-muted/20 focus:bg-background"
          />
        </div>
      </div>

      <div className="flex md:flex-col items-center justify-end md:justify-start gap-2 pt-2 md:pt-0 border-t md:border-t-0 md:border-l md:pl-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          onClick={() => onRemove(image.id)}
          title="Remove Slide"
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
