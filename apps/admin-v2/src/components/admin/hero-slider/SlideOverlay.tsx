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
        "flex w-[560px] max-w-[90vw] cursor-grabbing gap-2 rounded-lg border bg-background p-2.5 shadow-xl ring-2 ring-primary/20",
      )}
    >
      <div className="flex w-7 shrink-0 items-center justify-center text-foreground">
        <GripVertical className="w-5 h-5" />
      </div>

      <div
        className={cn(
          "relative shrink-0 overflow-hidden rounded-lg border bg-muted/30",
          type === "desktop"
            ? "aspect-16/5 w-[180px]"
            : "aspect-16/5 w-[132px]",
        )}
      >
        <img
          src={getOptimizedImageUrl(image.url)}
          alt={image.title}
          className="h-full w-full object-cover"
        />
      </div>

      <div className="grid flex-1 gap-2 opacity-50">
        <div className="h-8 w-full rounded-md bg-muted" />
        <div className="h-8 w-full rounded-md bg-muted" />
      </div>
    </div>
  );
}
