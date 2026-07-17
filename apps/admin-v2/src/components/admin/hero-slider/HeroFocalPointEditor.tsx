import type { MouseEvent } from "react";
import { Crosshair, RotateCcw } from "lucide-react";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import {
  HERO_SLIDE_DEFAULT_FOCAL_POINT,
  type HeroSlideFocalPoint,
} from "@scalius/shared/hero-slider";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";

interface HeroFocalPointEditorProps {
  imageId: string;
  imageUrl: string;
  imageText: string;
  focalPoint: HeroSlideFocalPoint;
  onChange: (focalPoint: HeroSlideFocalPoint) => void;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function HeroFocalPointEditor({
  imageId,
  imageUrl,
  imageText,
  focalPoint,
  onChange,
}: HeroFocalPointEditorProps) {
  const setFromImage = (event: MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    onChange({
      x: clampPercent(((event.clientX - bounds.left) / bounds.width) * 100),
      y: clampPercent(((event.clientY - bounds.top) / bounds.height) * 100),
    });
  };

  const source = getOptimizedImageUrl(imageUrl, {
    width: 720,
    height: null,
    quality: 85,
    fit: "scale-down",
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute bottom-1.5 right-1.5 z-10 h-7 gap-1 rounded-md bg-black/75 px-2 text-[11px] text-white shadow-sm backdrop-blur-sm hover:bg-black/90 hover:text-white"
          aria-label={`Set crop focus for ${imageText || "this slide"}`}
        >
          <Crosshair className="h-3.5 w-3.5" />
          Focus
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-3" align="start">
        <div>
          <p className="text-sm font-medium">Crop focus</p>
          <p className="text-xs text-muted-foreground">Click the subject that must stay visible.</p>
        </div>

        <div className="flex justify-center overflow-hidden rounded-md border bg-muted/30">
          <button
            type="button"
            className="relative inline-block max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            onClick={setFromImage}
            aria-label={`Choose crop focus. Current position ${focalPoint.x}% horizontal, ${focalPoint.y}% vertical.`}
          >
            <img
              src={source}
              alt=""
              className="block h-auto max-h-64 w-auto max-w-full"
              loading="lazy"
              decoding="async"
            />
            <span
              className="pointer-events-none absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/55 shadow-[0_0_0_1px_rgba(0,0,0,0.55)]"
              style={{ left: `${focalPoint.x}%`, top: `${focalPoint.y}%` }}
            >
              <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
            </span>
          </button>
        </div>

        <div className="grid gap-2">
          <div className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2">
            <Label htmlFor={`hero-focus-x-${imageId}`} className="text-xs font-normal">Horizontal</Label>
            <input
              id={`hero-focus-x-${imageId}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={focalPoint.x}
              onChange={(event) => onChange({ ...focalPoint, x: clampPercent(event.target.valueAsNumber) })}
              className="h-4 w-full accent-foreground"
            />
            <span className="text-right text-xs tabular-nums text-muted-foreground">{focalPoint.x}%</span>
          </div>
          <div className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2">
            <Label htmlFor={`hero-focus-y-${imageId}`} className="text-xs font-normal">Vertical</Label>
            <input
              id={`hero-focus-y-${imageId}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={focalPoint.y}
              onChange={(event) => onChange({ ...focalPoint, y: clampPercent(event.target.valueAsNumber) })}
              className="h-4 w-full accent-foreground"
            />
            <span className="text-right text-xs tabular-nums text-muted-foreground">{focalPoint.y}%</span>
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-2">
          <span className="text-[11px] text-muted-foreground">The preview updates before save.</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onChange({ ...HERO_SLIDE_DEFAULT_FOCAL_POINT })}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Center
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
