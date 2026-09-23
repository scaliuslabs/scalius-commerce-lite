import { GripVertical, X } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import {
  HERO_SLIDE_PRESENTATION,
  HERO_SLIDE_TITLE_LIMIT,
  getHeroSlideObjectPosition,
  type HeroSlide,
  type HeroSlideViewport,
} from "@scalius/shared/hero-slider";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import type { SortableItemRenderProps } from "~/components/admin/shared/SortableList";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { HeroFocalPointEditor } from "./HeroFocalPointEditor";

export function SlideRow({
  slide,
  index,
  viewport,
  sortable,
  onChange,
  onRemove,
}: {
  slide: HeroSlide;
  index: number;
  viewport: HeroSlideViewport;
  sortable: SortableItemRenderProps;
  onChange: (updates: Partial<HeroSlide>) => void;
  onRemove: () => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const link = parseNavigationHref(slide.link);
  const presentation = HERO_SLIDE_PRESENTATION[viewport];
  const textMissing = slide.title.trim().length === 0;
  const imageOk = /^https:\/\/[^@\s]+$/i.test(slide.url);
  return (
    <div
      ref={sortable.ref}
      style={sortable.style}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-background p-2.5 sm:flex-row sm:items-start",
        sortable.isDragging && "relative z-10 shadow-lg",
      )}
    >
      <div className="flex items-start gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 cursor-grab touch-none"
          aria-label={t("reorderBanner", { number: index + 1 })}
          {...sortable.dragHandleProps}
        >
          <GripVertical />
        </Button>
        <div
          className={cn(
            "relative w-full shrink-0 overflow-hidden rounded-md border bg-muted/30",
            viewport === "desktop" ? "sm:w-44" : "sm:w-32",
          )}
          style={{ aspectRatio: `${presentation.width} / ${presentation.height}` }}
        >
          <img
            src={mediaImageUrl(slide.url, 640)}
            alt=""
            className="h-full w-full object-cover"
            style={{ objectPosition: getHeroSlideObjectPosition(slide.focalPoint) }}
            loading="lazy"
            decoding="async"
          />
          <HeroFocalPointEditor
            imageId={slide.id}
            imageUrl={slide.url}
            imageText={slide.title}
            focalPoint={slide.focalPoint}
            onChange={(focalPoint) => onChange({ focalPoint })}
          />
        </div>
      </div>
      <div className="grid min-w-0 flex-1 gap-3">
        {!imageOk ? <p className="text-sm text-destructive">{t("bannerImageInvalid")}</p> : null}
        <div className="space-y-1.5">
          <Label htmlFor={`banner-text-${slide.id}`}>{t("bannerText")}</Label>
          <Input
            id={`banner-text-${slide.id}`}
            value={slide.title}
            maxLength={HERO_SLIDE_TITLE_LIMIT}
            onChange={(event) => onChange({ title: event.target.value })}
            aria-invalid={textMissing}
          />
          {textMissing ? <p className="text-sm text-destructive">{t("bannerTextRequired")}</p> : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`banner-link-${slide.id}`}>{t("bannerLink")}</Label>
          <Input
            id={`banner-link-${slide.id}`}
            value={slide.link}
            onChange={(event) => onChange({ link: event.target.value })}
            placeholder="/collections/new"
            aria-invalid={!link.ok}
          />
          {!link.ok ? <p className="text-sm text-destructive">{t("bannerLinkInvalid")}</p> : null}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="self-end sm:self-start"
        aria-label={t("removeBanner", { number: index + 1 })}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  );
}
