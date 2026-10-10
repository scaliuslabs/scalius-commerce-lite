/**
 * A section's settings: the form generated from its registry schema without
 * its blocks, and each block (a slide, a question) on its own. A hero
 * slide has its own control: its crop on both screens and its focus points;
 * slides are added from Files, several at once.
 */
import type { CSSProperties } from "react";
import { ImageIcon, Plus } from "lucide-react";
import { toast } from "~/lib/toast";
import { HERO_SLIDE_PRESENTATION, getHeroSlideObjectPosition, type HeroSlideViewport } from "@scalius/shared/hero-slider";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import {
  STOREFRONT_DEFAULT_FOCAL_POINT,
  STOREFRONT_HERO_SLIDE_LIMIT,
  STOREFRONT_HERO_SLIDE_TEXT_LIMITS,
  STOREFRONT_SECTION_REGISTRY,
  isStorefrontAppSection,
  storefrontSectionBlockLists,
  storefrontSettingAt,
  storefrontSettingWith,
  type StorefrontFocalPoint,
  type StorefrontHeroSlide,
  type StorefrontPlatformSection,
  type StorefrontSection,
  type StorefrontSectionType,
} from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
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
  replaceAt,
  type MediaPreviews,
  type SectionMediaPreview,
} from "./schema-form/resource-fields";
import { SchemaSettingsForm } from "./schema-form/SchemaSettingsForm";
import { blockListSpec } from "./theme-editor/editor-state";
import { Field } from "~/components/ui/field";

type Section = StorefrontSection;

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
    <Field id={id} label={label}>
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
    </Field>
  );
}

/** One slide's images, words and link: in the hero's list, or alone when the editor opens the slide as a block. */
export function HeroSlideFields({ id, index, slide, media, error, onChange }: {
  /** The slides' field id (`theme-section-hero-slides`). */
  id: string;
  index: number;
  slide: StorefrontHeroSlide;
  media: MediaPreviews;
  /** The error at a part of this slide (`image`, `alt`). */
  error: (part: string) => string | undefined;
  onChange: (slide: StorefrontHeroSlide) => void;
}) {
  const labels = useMessages(themeSettingMessages);
  const name = labels("s.hero.slides.item", { number: index + 1 });
  const field = (part: string) => `${id}-${index}-${part}`;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 @md:grid-cols-2">
        <SlideImage
          id={field("image")}
          name={name}
          label={labels("s.hero.slides.image")}
          viewport="desktop"
          mediaId={slide.image || null}
          previews={media.previews}
          focalPoint={slide.focalPoint}
          error={error("image")}
          onPick={(image) => {
            media.remember(image);
            onChange({ ...slide, image: image.id, alt: slide.alt || image.alt.slice(0, STOREFRONT_HERO_SLIDE_TEXT_LIMITS.alt) });
          }}
          onFocalPoint={(focalPoint) => onChange({ ...slide, focalPoint })}
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
          error={error("phoneImage")}
          onPick={(image) => {
            media.remember(image);
            onChange({ ...slide, phoneImage: image.id, phoneFocalPoint: slide.phoneFocalPoint ?? { ...STOREFRONT_DEFAULT_FOCAL_POINT } });
          }}
          onFocalPoint={(phoneFocalPoint) => onChange({ ...slide, phoneFocalPoint })}
          onRemove={() => {
            const { phoneImage: _image, phoneFocalPoint: _focus, ...rest } = slide;
            onChange(rest);
          }}
        />
      </div>
      <SlideText id={field("alt")} label={labels("s.hero.slides.alt")} help={labels("s.hero.slides.alt.help")} value={slide.alt} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.alt} error={error("alt")} onChange={(alt) => onChange({ ...slide, alt })} />
      <SlideText id={field("heading")} label={labels("s.hero.slides.heading")} help={labels("s.hero.slides.heading.help")} value={slide.heading ?? ""} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.heading} error={error("heading")} onChange={(heading) => onChange(withSlideText(slide, "heading", heading))} />
      <SlideText id={field("text")} label={labels("s.hero.slides.text")} value={slide.text ?? ""} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.text} error={error("text")} onChange={(text) => onChange(withSlideText(slide, "text", text))} />
      <LinkField id={field("link")} label={labels("f.link")} value={slide.link} error={error("link")} onChange={(link) => onChange({ ...slide, link })} />
      {slide.link ? (
        <SlideText id={field("button")} label={labels("s.hero.slides.buttonLabel")} help={labels("s.hero.slides.buttonLabel.help")} value={slide.buttonLabel ?? ""} max={STOREFRONT_HERO_SLIDE_TEXT_LIMITS.buttonLabel} error={error("buttonLabel")} onChange={(buttonLabel) => onChange(withSlideText(slide, "buttonLabel", buttonLabel))} />
      ) : null}
    </div>
  );
}

/** New slides from Files, several at once (each with its focus point centred and its alt text). */
export function HeroAddSlides({ slides, media, onChange }: {
  slides: readonly StorefrontHeroSlide[];
  media: MediaPreviews;
  onChange: (slides: StorefrontHeroSlide[]) => void;
}) {
  const t = useMessages(onlineStoreMessages);
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
  if (full) return <p className="text-body text-muted-foreground">{t("slideLimit", { count: STOREFRONT_HERO_SLIDE_LIMIT })}</p>;
  return (
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
  );
}

/** The block lists of a section (edited as rows of the editor's tree, never inside the section's own form). */
function blockPaths(type: StorefrontSectionType): Set<string> {
  return new Set(storefrontSectionBlockLists(type).map((list) => list.path));
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

/**
 * The generated settings form of one platform section: its own settings,
 * without its blocks (the editor's tree lists them; each opens on its own).
 */
export function SectionSettingsForm({ section, media, onChange, errors }: {
  section: StorefrontPlatformSection;
  media: MediaPreviews;
  onChange: (settings: StorefrontPlatformSection["settings"]) => void;
  errors?: ReadonlyMap<string, string>;
}) {
  const blocks = blockPaths(section.type);
  return (
    <SchemaSettingsForm
      idPrefix={sectionFieldPrefix(section.id)}
      scope={sectionLabelScope(section.type)}
      spec={sectionSettingSpec(section.type)}
      value={section.settings as Record<string, unknown>}
      onChange={(settings) => onChange(settings as StorefrontPlatformSection["settings"])}
      errors={errors}
      // A hero's phone height applies to the full-screen layout only.
      visible={(path, parent) => !blocks.has(path) && (section.type !== "hero" || path !== "phoneHeight" || parent.layout === "full-screen")}
      media={media}
    />
  );
}

/** One block of a section (a slide, a question, a card) on its own: its fields, as the section's list draws them. */
export function BlockSettingsForm({ section, path, index, media, onChange, errors }: {
  section: StorefrontPlatformSection;
  path: string;
  index: number;
  media: MediaPreviews;
  onChange: (settings: StorefrontPlatformSection["settings"]) => void;
  errors?: ReadonlyMap<string, string>;
}) {
  const list = storefrontSettingAt(section.settings, path);
  const items = Array.isArray(list) ? list : [];
  const item = items[index];
  const spec = blockListSpec(section.type, path, section.settings);
  if (item === undefined || !spec) return null;
  const set = (next: unknown) => onChange(storefrontSettingWith(section.settings, path, replaceAt(items, index, next)));
  const prefix = sectionFieldPrefix(section.id);
  if (section.type === "hero" && path === "slides") {
    return (
      <HeroSlideFields
        id={`${prefix}-slides`}
        index={index}
        slide={item as StorefrontHeroSlide}
        media={media}
        error={(part) => errors?.get(`slides.${index}.${part}`)}
        onChange={set}
      />
    );
  }
  return (
    <SchemaSettingsForm
      idPrefix={prefix}
      scope={sectionLabelScope(section.type)}
      spec={{ ...spec.item, nullable: false, optional: false }}
      value={item as Record<string, unknown>}
      rootPath={path}
      rootDataPath={`${path}.${index}`}
      onChange={set}
      errors={errors}
      media={media}
    />
  );
}
