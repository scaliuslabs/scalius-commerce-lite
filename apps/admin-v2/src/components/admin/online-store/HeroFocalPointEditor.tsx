import type { CSSProperties, MouseEvent } from "react";
import { Crosshair, RotateCcw } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  HERO_SLIDE_DEFAULT_FOCAL_POINT,
  type HeroSlideFocalPoint,
} from "@scalius/shared/hero-slider";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
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
  const t = useMessages(onlineStoreMessages);
  const setFromImage = (event: MouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    onChange({
      x: clampPercent(((event.clientX - bounds.left) / bounds.width) * 100),
      y: clampPercent(((event.clientY - bounds.top) / bounds.height) * 100),
    });
  };

  const source = mediaImageUrl(imageUrl, 960);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute bottom-1.5 right-1.5 z-10"
          aria-label={t("focusFor", { name: imageText || t("thisBanner") })}
        >
          <Crosshair />
          {t("focus")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3" align="start">
        <div className="space-y-1">
          <p className="text-heading-sm">{t("focusTitle")}</p>
          <p className="text-body text-muted-foreground">{t("focusHelp")}</p>
        </div>

        <div className="flex justify-center overflow-clip rounded-md bg-muted">
          <button
            type="button"
            className="relative inline-block max-w-full rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={setFromImage}
            aria-label={t("focusTitle")}
          >
            <img
              src={source}
              alt=""
              className="block h-auto max-h-64 w-auto max-w-full"
              loading="lazy"
              decoding="async"
            />
            <span
              style={{ "--focus-x": `${focalPoint.x}%`, "--focus-y": `${focalPoint.y}%` } as CSSProperties}
              className="pointer-events-none absolute top-(--focus-y) left-(--focus-x) size-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-background"
            >
              <span className="absolute left-1/2 top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-background" />
            </span>
          </button>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor={`hero-focus-x-${imageId}`} className="w-24 shrink-0">{t("horizontal")}</Label>
            <input
              id={`hero-focus-x-${imageId}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={focalPoint.x}
              onChange={(event) => onChange({ ...focalPoint, x: clampPercent(event.target.valueAsNumber) })}
              className="h-4 min-w-0 flex-1 accent-primary"
            />
            <span className="w-10 shrink-0 text-right text-body tabular-nums text-muted-foreground">{focalPoint.x}%</span>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor={`hero-focus-y-${imageId}`} className="w-24 shrink-0">{t("vertical")}</Label>
            <input
              id={`hero-focus-y-${imageId}`}
              type="range"
              min={0}
              max={100}
              step={1}
              value={focalPoint.y}
              onChange={(event) => onChange({ ...focalPoint, y: clampPercent(event.target.valueAsNumber) })}
              className="h-4 min-w-0 flex-1 accent-primary"
            />
            <span className="w-10 shrink-0 text-right text-body tabular-nums text-muted-foreground">{focalPoint.y}%</span>
          </div>
        </div>

        <div className="flex justify-end border-t border-border pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ ...HERO_SLIDE_DEFAULT_FOCAL_POINT })}
          >
            <RotateCcw />
            {t("center")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
