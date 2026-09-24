import type { CSSProperties } from "react";
import { GripVertical, Search, X } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import {
  HERO_SLIDE_BUTTON_LABEL_LIMIT,
  HERO_SLIDE_PRESENTATION,
  HERO_SLIDE_TITLE_LIMIT,
  getHeroSlideObjectPosition,
  normalizeHeroSlideImageUrl,
  type HeroSlide,
  type HeroSlideViewport,
} from "@scalius/shared/hero-slider";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { SortableItemRenderProps } from "~/components/admin/shared/SortableList";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { HeroFocalPointEditor } from "./HeroFocalPointEditor";
import { NavigationResourcePicker } from "./NavigationResourcePicker";
import { Field } from "./shared";

/** Control ids of one banner, so server errors mark the right field. */
export const bannerFieldId = (slideId: string, field: "text" | "heading" | "button" | "link") => `banner-${field}-${slideId}`;

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
  const presentation = HERO_SLIDE_PRESENTATION[viewport];
  const textId = bannerFieldId(slide.id, "text");
  const linkId = bannerFieldId(slide.id, "link");
  const headingId = bannerFieldId(slide.id, "heading");
  const buttonId = bannerFieldId(slide.id, "button");
  return (
    <div
      ref={sortable.ref}
      // eslint-disable-next-line shadcn/no-inline-styles -- dnd-kit moves the dragged row with a live transform.
      style={sortable.style}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-3 sm:flex-row sm:items-start",
        sortable.isDragging && "relative z-10",
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
        <div className={cn("flex min-w-0 flex-1 flex-col items-start gap-2 sm:flex-none", viewport === "desktop" ? "sm:w-44" : "sm:w-32")}>
          <div
            // The crop preview follows the merchant's focus point (runtime values as custom properties).
            style={{
              "--ratio": `${presentation.width} / ${presentation.height}`,
              "--focus": getHeroSlideObjectPosition(slide.focalPoint),
            } as CSSProperties}
            className="aspect-(--ratio) w-full overflow-clip rounded-md bg-muted"
          >
            <img
              src={mediaImageUrl(slide.url, 640)}
              alt=""
              className="size-full object-cover object-(--focus)"
              loading="lazy"
              decoding="async"
            />
          </div>
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
        {normalizeHeroSlideImageUrl(slide.url) ? null : (
          <p role="alert" className="text-body text-destructive">{t("bannerImageInvalid")}</p>
        )}
        <Field
          id={textId}
          label={t("bannerText")}
          help={t("bannerTextHelp")}
          error={slide.title.trim() ? undefined : t("bannerTextRequired")}
        >
          <Input
            id={textId}
            value={slide.title}
            maxLength={HERO_SLIDE_TITLE_LIMIT}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </Field>
        <Field id={headingId} label={t("bannerHeading")} help={t("bannerHeadingHelp")}>
          <Input
            id={headingId}
            value={slide.heading}
            maxLength={HERO_SLIDE_TITLE_LIMIT}
            onChange={(event) => onChange({ heading: event.target.value })}
          />
        </Field>
        <Field
          id={linkId}
          label={t("bannerLink")}
          error={parseNavigationHref(slide.link).ok ? undefined : t("bannerLinkInvalid")}
        >
          <Input
            id={linkId}
            value={slide.link}
            placeholder={t("bannerLinkPlaceholder")}
            onChange={(event) => onChange({ link: event.target.value })}
          />
        </Field>
        <NavigationResourcePicker
          id={`${linkId}-browse`}
          type="collection"
          types={["collection", "category", "product", "page"]}
          value=""
          trigger={
            <Button type="button" variant="outline" size="sm" className="justify-self-start" aria-label={t("browseFor", { number: index + 1 })}>
              <Search />
              {t("browse")}
            </Button>
          }
          onValueChange={(option) => onChange({ link: option.url })}
        />
        {slide.link.trim() ? (
          <Field id={buttonId} label={t("bannerButton")} help={t("bannerButtonHelp")}>
            <Input
              id={buttonId}
              value={slide.buttonLabel}
              maxLength={HERO_SLIDE_BUTTON_LABEL_LIMIT}
              onChange={(event) => onChange({ buttonLabel: event.target.value })}
            />
          </Field>
        ) : null}
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
