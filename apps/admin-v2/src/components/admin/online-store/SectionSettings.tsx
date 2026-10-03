/**
 * A homepage section's settings: the form generated from its registry
 * schema, with the hero's slides drawn by their own control (each slide's
 * crop on both screens, its focus points, several slides added from Files
 * at once) and settings that only one layout uses shown with that layout.
 */
import type { CSSProperties } from "react";
import { ArrowDown, ArrowUp, ImageIcon, Plus, Trash2 } from "lucide-react";
import { toast } from "~/lib/toast";
import { HERO_SLIDE_PRESENTATION, getHeroSlideObjectPosition, type HeroSlideViewport } from "@scalius/shared/hero-slider";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  STOREFRONT_DEFAULT_FOCAL_POINT,
  STOREFRONT_HERO_SLIDE_LIMIT,
  STOREFRONT_HERO_SLIDE_TEXT_LIMITS,
  STOREFRONT_SECTION_REGISTRY,
  isStorefrontAppSection,
  type StorefrontFocalPoint,
  type StorefrontHeroSlide,
  type StorefrontPlatformSection,
  type StorefrontSection,
  type StorefrontSectionType,
} from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { MediaManager, type MediaFile } from "~/components/admin/media-manager";
import { useServerFieldError } from "~/components/admin/shared/SaveBar";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeSettingMessages } from "~/i18n/theme-settings";
import { HeroFocalPointEditor } from "./HeroFocalPointEditor";
import { settingErrors } from "./schema-form/errors";
import { sectionLabelScope } from "./schema-form/labels";
import { sectionSettingSpec } from "./schema-form/registry-forms";
import {
  LinkField,
  mediaPreview,
  moveAt,
  removeAt,
  replaceAt,
  type MediaPreviews,
  type SectionMediaPreview,
} from "./schema-form/resource-fields";
import { SchemaSettingsForm, type SettingWidgetProps } from "./schema-form/SchemaSettingsForm";
import { nextFreeId } from "./theme-settings";

type Section = StorefrontSection;

/** A new section id: the type (`app` for an app's section), then -2, -3… until it is free. */
export function newSectionId(type: Section["type"], sections: readonly Section[]): string {
  return nextFreeId(type, sections);
}

/** The field ids of a section's settings start with this. */
export const sectionFieldPrefix = (sectionId: string) => `theme-section-${sectionId}`;

/** A slide image: the banner's crop on that screen (its focal point kept in frame), Select or Change, the focus point, and Remove when given. */
function SlideImage({ id, name, label, help, viewport, mediaId, previews, focalPoint, error, onPick, onFocalPoint, onRemove }: {
  id: string;
  /** The slide, for the focus button's name ("Slide 2"). */
  name: string;
  label: string;
  help?: string;
  viewport: HeroSlideViewport;
  mediaId: string | null;
  previews: ReadonlyMap<string, SectionMediaPreview>;
  focalPoint: StorefrontFocalPoint;
  error?: string;
  onPick: (image: SectionMediaPreview) => void;
  onFocalPoint: (focalPoint: StorefrontFocalPoint) => void;
  onRemove?: () => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const server = useServerFieldError(id);
  const shown = error ?? server.error;
  const preview = mediaId ? previews.get(mediaId) : undefined;
  const { width, height } = HERO_SLIDE_PRESENTATION[viewport];
  return (
    <div id={id} role="group" aria-labelledby={`${id}-label`} className="min-w-0 space-y-1.5">
      <p id={`${id}-label`} className="text-body font-medium">{label}</p>
      <div
        // The crop follows the merchant's focus point (runtime values as custom properties).
        style={{ "--ratio": `${width} / ${height}`, "--focus": getHeroSlideObjectPosition(focalPoint) } as CSSProperties}
        className="grid aspect-(--ratio) w-full place-items-center overflow-clip rounded-lg border bg-muted"
      >
        {preview ? (
          <img src={mediaImageUrl(preview.url, 640)} alt="" className="size-full object-cover object-(--focus)" loading="lazy" decoding="async" />
        ) : (
          <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
      <div className="flex flex-wrap gap-2">
        <MediaManager
          capability="image"
          onSelect={(file) => {
            server.clear();
            onPick(mediaPreview(file));
          }}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-invalid={shown ? true : undefined}
              aria-describedby={shown ? `${id}-note` : undefined}
            >
              {mediaId ? t("changeImage") : t("selectImage")}
            </Button>
          }
        />
        {preview ? (
          <HeroFocalPointEditor
            id={`${id}-focus`}
            imageUrl={preview.url}
            label={t("slideImageName", { slide: name, image: label })}
            focalPoint={focalPoint}
            onChange={onFocalPoint}
          />
        ) : null}
        {mediaId && onRemove ? (
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>{t("remove")}</Button>
        ) : null}
      </div>
      {shown ? <p id={`${id}-note`} role="alert" className="text-body text-destructive">{shown}</p> : null}
    </div>
  );
}

/** An optional slide text: absent (not an empty string) when cleared. */
function withSlideText(slide: StorefrontHeroSlide, key: "heading" | "text" | "buttonLabel", value: string): StorefrontHeroSlide {
  const next = { ...slide };
  if (value === "") delete next[key];
  else next[key] = value;
  return next;
}

function SlideText({ id, label, help, value, max, error, onChange }: {
  id: string;
  label: string;
  help?: string;
  value: string;
  max: number;
  error?: string;
  onChange: (value: string) => void;
}) {
  const note = error ?? help;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        maxLength={max}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? (
        <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p>
      ) : help ? (
        <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/**
 * The hero's slides, in order: each a computer image and an optional phone
 * image (each with its focus point), the alt text, optional words over the
 * image and a link with its button. Slides are added from Files, several at
 * once.
 */
function HeroSlides({ id, label, value, onChange, error, media }: SettingWidgetProps) {
  const t = useMessages(onlineStoreMessages);
  const labels = useMessages(themeSettingMessages);
  const slides = (value ?? []) as StorefrontHeroSlide[];
  const full = slides.length >= STOREFRONT_HERO_SLIDE_LIMIT;
  const add = (files: MediaFile[]) => {
    const accepted = files.slice(0, Math.max(0, STOREFRONT_HERO_SLIDE_LIMIT - slides.length));
    if (accepted.length < files.length) toast.warning(t("slideLimit", { count: STOREFRONT_HERO_SLIDE_LIMIT }));
    accepted.forEach((file) => media.remember(mediaPreview(file)));
    onChange([
      ...slides,
      ...accepted.map((file) => ({
        image: file.id,
        focalPoint: { ...STOREFRONT_DEFAULT_FOCAL_POINT },
        alt: (file.altText?.trim() ?? "").slice(0, STOREFRONT_HERO_SLIDE_TEXT_LIMITS.alt),
        link: null,
      })),
    ]);
  };
  const set = (index: number, slide: StorefrontHeroSlide) => onChange(replaceAt(slides, index, slide));
  const { desktop, mobile } = HERO_SLIDE_PRESENTATION;
  return (
    <fieldset id={id} className="space-y-3">
      <legend className="text-body font-medium">{label}</legend>
      <p className="text-body text-muted-foreground">
        {t("heroSlidesHelp", {
          count: STOREFRONT_HERO_SLIDE_LIMIT,
          desktop: `${desktop.width} × ${desktop.height}`,
          phone: `${mobile.width} × ${mobile.height}`,
        })}
      </p>
      {slides.map((slide, index) => {
        const name = labels("s.hero.slides.item", { number: index + 1 });
        const field = (part: string) => `${id}-${index}-${part}`;
        const at = (part: string) => error(`${index}.${part}`);
        return (
          <div key={index} className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center gap-1">
              <p className="min-w-0 flex-1 text-heading-sm">{name}</p>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionUp", { name })} disabled={index === 0} onClick={() => onChange(moveAt(slides, index, -1))}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveSectionDown", { name })} disabled={index === slides.length - 1} onClick={() => onChange(moveAt(slides, index, 1))}>
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeItem", { name })} onClick={() => onChange(removeAt(slides, index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            <div className="grid gap-3 @md:grid-cols-2">
              <SlideImage
                id={field("image")}
                name={name}
                label={labels("s.hero.slides.image")}
                viewport="desktop"
                mediaId={slide.image}
                previews={media.previews}
                focalPoint={slide.focalPoint}
                error={at("image")}
                onPick={(image) => {
                  media.remember(image);
                  set(index, { ...slide, image: image.id, alt: slide.alt || image.alt.slice(0, STOREFRONT_HERO_SLIDE_TEXT_LIMITS.alt) });
                }}
                onFocalPoint={(focalPoint) => set(index, { ...slide, focalPoint })}
              />
              <SlideImage
                id={field("phone-image")}
                name={name}
                label={labels("s.hero.slides.phoneImage")}
                help={labels("s.hero.slides.phoneImage.help")}
                viewport="mobile"
                mediaId={slide.phoneImage ?? null}
                previews={media.previews}
                focalPoint={slide.phoneFocalPoint ?? STOREFRONT_DEFAULT_FOCAL_POINT}
                error={at("phoneImage")}
                onPick={(image) => {
                  media.remember(image);
                  set(index, { ...slide, phoneImage: image.id, phoneFocalPoint: slide.phoneFocalPoint ?? { ...STOREFRONT_DEFAULT_FOCAL_POINT } });
                }}
                onFocalPoint={(phoneFocalPoint) => set(index, { ...slide, phoneFocalPoint })}
                onRemove={() => {
                  const { phoneImage: _image, phoneFocalPoint: _focus, ...rest } = slide;
                  set(index, rest);
                }}
              />
            </div>
            <SlideText id={field("alt")} label={labels("s.hero.slides.alt")} help={labels("s.hero.slides.alt.help")} value={slide.alt} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.alt} error={at("alt")} onChange={(alt) => set(index, { ...slide, alt })} />
            <SlideText id={field("heading")} label={labels("s.hero.slides.heading")} help={labels("s.hero.slides.heading.help")} value={slide.heading ?? ""} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.heading} error={at("heading")} onChange={(heading) => set(index, withSlideText(slide, "heading", heading))} />
            <SlideText id={field("text")} label={labels("s.hero.slides.text")} value={slide.text ?? ""} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.text} error={at("text")} onChange={(text) => set(index, withSlideText(slide, "text", text))} />
            <LinkField id={field("link")} label={labels("f.link")} value={slide.link} error={at("link")} onChange={(link) => set(index, { ...slide, link })} />
            {slide.link ? (
              <SlideText id={field("button")} label={labels("s.hero.slides.buttonLabel")} help={labels("s.hero.slides.buttonLabel.help")} value={slide.buttonLabel ?? ""} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.buttonLabel} error={at("buttonLabel")} onChange={(buttonLabel) => set(index, withSlideText(slide, "buttonLabel", buttonLabel))} />
            ) : null}
          </div>
        );
      })}
      {error() ? <p role="alert" className="text-body text-destructive">{error()}</p> : null}
      {full ? (
        <p className="text-body text-muted-foreground">{t("slideLimit", { count: STOREFRONT_HERO_SLIDE_LIMIT })}</p>
      ) : (
        <MediaManager
          capability="image"
          onSelect={(file) => add([file])}
          onSelectMultiple={add}
          trigger={
            <Button type="button" variant="outline" size="sm">
              <Plus aria-hidden="true" />
              {t("addSlides")}
            </Button>
          }
        />
      )}
    </fieldset>
  );
}

const HERO_WIDGETS = { slides: HeroSlides };

/** Settings one layout uses, shown with that layout only. */
function sectionSettingVisible(type: StorefrontSectionType) {
  if (type !== "hero") return undefined;
  return (path: string, parent: Record<string, unknown>) => {
    if (path === "sideBanners") return parent.layout === "contained-banners";
    if (path === "phoneHeight") return parent.layout === "full-screen";
    return true;
  };
}

const NO_ERRORS: ReadonlyMap<string, string> = new Map();

/**
 * A platform section's settings errors as shown messages, by data path under
 * `settings`. An app section's settings are its app's: the app settings form
 * checks them against the fields the app declares (useAppSettingErrors).
 */
export function useSectionErrors(section: Section): ReadonlyMap<string, string> {
  const t = useMessages(themeSettingMessages);
  if (isStorefrontAppSection(section)) return NO_ERRORS;
  const errors = settingErrors(STOREFRONT_SECTION_REGISTRY[section.type].settings, section.settings);
  return new Map([...errors].map(([path, error]) => [path, t(error.key, error.values)]));
}

/** The generated settings form of one platform section. */
export function SectionSettingsForm({ section, media, onChange, errors }: {
  section: StorefrontPlatformSection;
  media: MediaPreviews;
  onChange: (settings: StorefrontPlatformSection["settings"]) => void;
  errors?: ReadonlyMap<string, string>;
}) {
  return (
    <SchemaSettingsForm
      idPrefix={sectionFieldPrefix(section.id)}
      scope={sectionLabelScope(section.type)}
      spec={sectionSettingSpec(section.type)}
      value={section.settings as Record<string, unknown>}
      onChange={(settings) => onChange(settings as StorefrontPlatformSection["settings"])}
      errors={errors}
      widgets={section.type === "hero" ? HERO_WIDGETS : undefined}
      visible={sectionSettingVisible(section.type)}
      media={media}
    />
  );
}
