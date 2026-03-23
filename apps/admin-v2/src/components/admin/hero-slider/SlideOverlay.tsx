import { GripVertical } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { cn } from "@scalius/shared/utils";
import type { SliderImage } from "./helpers";

export function SlideOverlay({
  image,
  type,
}: {
  image: SliderImage;
  type: "desktop" | "mobile";
}) {
  return (
    <div
      className={cn(
        "flex flex-col md:flex-row gap-4 p-4 rounded-xl border bg-background shadow-xl ring-2 ring-primary/20 cursor-grabbing w-[600px] max-w-[90vw]",
      )}
    >
      <div className="shrink-0 flex items-center justify-center w-8 text-foreground">
        <GripVertical className="w-5 h-5" />
      </div>

      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-lg border bg-muted/30",
          type === "desktop"
            ? "aspect-16/5 w-[280px]"
            : "aspect-16/5 w-[200px]",
        )}
      >
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.title}
          className="h-full w-full object-cover"
        />
      </div>

      <div className="flex-1 grid gap-4 opacity-50">
        <div className="h-9 w-full bg-muted rounded-md" />
        <div className="h-9 w-full bg-muted rounded-md" />
      </div>
    </div>
  );
}
