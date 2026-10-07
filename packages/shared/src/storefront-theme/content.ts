// The merchant's own content inside a theme document, as opposed to its
// look: the brand (logo, footer logo, tab icon, logo width), the
// announcement's words and link, the footer's words, the hero's slides and
// side banners, the category tiles' categories and title, the collections
// section's collections, and what `/` shows. Choosing another template keeps
// it (`storefrontThemeWithContent`), and "does this still match a template"
// compares looks only (`storefrontThemeLook`).
import { DEFAULT_STOREFRONT_THEME_BRAND } from "./brand";
import { storefrontVariantSpec } from "./blocks";
import { emptyStorefrontPageTemplates } from "./pages";
import type { StorefrontThemeDocument } from "./document";
import { STOREFRONT_SECTION_REGISTRY, type StorefrontSection, type StorefrontSectionType } from "./sections";

/** Block settings that are the merchant's words, by slot. */
export const STOREFRONT_BLOCK_CONTENT_KEYS = {
  topBar: ["text", "link"],
  footer: ["tagline", "about", "copyright"],
} as const;

/** Section settings that are the merchant's content, by section type. */
export const STOREFRONT_SECTION_CONTENT_KEYS: Partial<Record<StorefrontSectionType, readonly string[]>> = {
  hero: ["slides", "sideBanners"],
  "category-tiles": ["categoryIds", "title"],
  collections: ["collectionIds"],
};

type ContentSlot = keyof typeof STOREFRONT_BLOCK_CONTENT_KEYS;

function withBlockContent<Block extends { variant: string; settings: Record<string, unknown> }>(
  slot: ContentSlot,
  target: Block,
  source: { settings: Record<string, unknown> } | null,
): Block {
  const spec = storefrontVariantSpec(slot, target.variant);
  let settings = { ...target.settings };
  for (const key of STOREFRONT_BLOCK_CONTENT_KEYS[slot]) {
    if (!(key in settings)) continue;
    const value = source && key in source.settings ? source.settings[key] : spec.defaults[key];
    const candidate = { ...settings, [key]: structuredClone(value) };
    if (spec.settings.safeParse(candidate).success) settings = candidate;
  }
  return { ...target, settings };
}

function withSectionContent(target: StorefrontSection, source: StorefrontSection | null): StorefrontSection {
  // An app section's values are the app's, never template content.
  if (target.type === "app") return target;
  const keys = STOREFRONT_SECTION_CONTENT_KEYS[target.type];
  if (!keys) return target;
  const defaults = STOREFRONT_SECTION_REGISTRY[target.type].defaults as Record<string, unknown>;
  const from = (source?.settings ?? defaults) as Record<string, unknown>;
  const settings = { ...(target.settings as Record<string, unknown>) };
  for (const key of keys) {
    if (key in from && from[key] !== undefined) settings[key] = structuredClone(from[key]);
    else if (key in defaults) settings[key] = structuredClone(defaults[key]);
    else delete settings[key];
  }
  const next = { ...target, settings } as StorefrontSection;
  return STOREFRONT_SECTION_REGISTRY[target.type].schema.safeParse(next).success ? next : target;
}

/**
 * `target` with `source`'s content: its brand and home mode, its
 * announcement and footer words (where the target's variants carry them),
 * and the content of its hero, category tiles and collections sections,
 * each given to the target's section of the same type in the same order
 * (the first hero to the first hero). Pass null to clear the content.
 */
export function storefrontThemeWithContent(
  target: StorefrontThemeDocument,
  source: StorefrontThemeDocument | null,
): StorefrontThemeDocument {
  const seen = new Map<StorefrontSection["type"], number>();
  const home = target.pages.home.map((section) => {
    const index = seen.get(section.type) ?? 0;
    seen.set(section.type, index + 1);
    const match = source?.pages.home.filter((each) => each.type === section.type)[index] ?? null;
    return withSectionContent(section, match);
  });
  return {
    ...target,
    brand: source ? structuredClone(source.brand) : { ...DEFAULT_STOREFRONT_THEME_BRAND },
    blocks: {
      ...target.blocks,
      topBar: withBlockContent("topBar", target.blocks.topBar, source?.blocks.topBar ?? null),
      footer: withBlockContent("footer", target.blocks.footer, source?.blocks.footer ?? null),
    } as StorefrontThemeDocument["blocks"],
    pages: {
      ...target.pages,
      home,
      homeMode: source ? structuredClone(source.pages.homeMode) : { kind: "sections" },
      landing: source ? structuredClone(source.pages.landing) : {},
      // The merchant's sections around the fixed parts are content too.
      templates: source ? structuredClone(source.pages.templates) : emptyStorefrontPageTemplates(),
    },
  };
}

/** The document's look: everything but its content (content reset to empty). */
export function storefrontThemeLook(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  return storefrontThemeWithContent(theme, null);
}

/** One image a document names: where (a document path) and which media id. */
export interface StorefrontThemeMediaReference {
  path: string;
  mediaId: string;
}

function sectionMediaReferences(section: StorefrontSection, at: string): StorefrontThemeMediaReference[] {
  const ref = (path: string, mediaId: string | null | undefined) => (mediaId ? [{ path: `${at}.settings.${path}`, mediaId }] : []);
  switch (section.type) {
    case "hero":
      return [
        ...section.settings.slides.flatMap((slide, index) => [
          ...ref(`slides.${index}.image`, slide.image),
          ...ref(`slides.${index}.phoneImage`, slide.phoneImage),
        ]),
        ...(section.settings.sideBanners ?? []).flatMap((banner, index) => ref(`sideBanners.${index}.mediaId`, banner.mediaId)),
      ];
    case "banner":
    case "lookbook":
      return ref("mediaId", section.settings.mediaId);
    case "editorial":
      return section.settings.layout === "image-with-text" ? ref("mediaId", section.settings.mediaId) : [];
    case "shop-by":
      return section.settings.cards.flatMap((card, index) => ref(`cards.${index}.mediaId`, card.mediaId));
    case "banner-mosaic":
      return section.settings.tiles.flatMap((tile, index) => ref(`tiles.${index}.mediaId`, tile.mediaId));
    default:
      return [];
  }
}

/**
 * Every image the document names, with its path (`brand.logo`,
 * `pages.home.2.settings.slides.0.image`, ...): what a save checks exists
 * and what the dashboard previews. Not capped (the homepage read is).
 */
export function storefrontThemeMediaReferences(theme: StorefrontThemeDocument): StorefrontThemeMediaReference[] {
  const brand = (["logo", "footerLogo", "favicon"] as const).flatMap((key) =>
    theme.brand[key] ? [{ path: `brand.${key}`, mediaId: theme.brand[key]! }] : []);
  return [
    ...brand,
    ...theme.pages.home.flatMap((section, index) => sectionMediaReferences(section, `pages.home.${index}`)),
    ...Object.entries(theme.pages.landing).flatMap(([slug, page]) => page.sections.flatMap((section, index) =>
      sectionMediaReferences(section, `pages.landing.${slug}.sections.${index}`))),
    ...Object.entries(theme.pages.templates).flatMap(([kind, template]) => template.sections.flatMap((section, index) =>
      sectionMediaReferences(section, `pages.templates.${kind}.sections.${index}`))),
  ];
}

/** A section without the images in `missing` (see `storefrontThemeWithoutMedia`). */
function sectionWithoutMedia(section: StorefrontSection, missing: ReadonlySet<string>): StorefrontSection {
  const gone = (mediaId: string | null | undefined) => mediaId != null && missing.has(mediaId);
  switch (section.type) {
    case "hero": {
      const { sideBanners, ...settings } = section.settings;
      return {
        ...section,
        settings: {
          ...settings,
          slides: section.settings.slides.filter((slide) => !gone(slide.image)).map((slide) => {
            if (!gone(slide.phoneImage)) return slide;
            const { phoneImage: _phoneImage, ...rest } = slide;
            return rest;
          }),
          ...(sideBanners ? { sideBanners: sideBanners.filter((banner) => !gone(banner.mediaId)) } : {}),
        },
      } as StorefrontSection;
    }
    case "banner":
    case "lookbook":
      return gone(section.settings.mediaId) ? { ...section, settings: { ...section.settings, mediaId: null } } as StorefrontSection : section;
    case "editorial":
      return section.settings.layout === "image-with-text" && gone(section.settings.mediaId)
        ? { ...section, settings: { ...section.settings, mediaId: null } }
        : section;
    case "shop-by":
      return { ...section, settings: { ...section.settings, cards: section.settings.cards.filter((card) => !gone(card.mediaId)) } };
    case "banner-mosaic":
      return { ...section, settings: { ...section.settings, tiles: section.settings.tiles.filter((tile) => !gone(tile.mediaId)) } };
    default:
      return section;
  }
}

/**
 * The document without the images in `missing` (deleted from Files since
 * it was published): brand images and a section's single image become
 * empty, a slide, side banner, card or mosaic tile showing one is left
 * out, and a slide's phone image falls back to the slide's own. Restoring
 * a version "without missing images" saves this.
 */
export function storefrontThemeWithoutMedia(theme: StorefrontThemeDocument, missing: ReadonlySet<string>): StorefrontThemeDocument {
  if (missing.size === 0) return theme;
  const brand = { ...theme.brand };
  for (const key of ["logo", "footerLogo", "favicon"] as const) {
    if (brand[key] && missing.has(brand[key]!)) brand[key] = null;
  }
  return {
    ...theme,
    brand,
    pages: {
      ...theme.pages,
      home: theme.pages.home.map((section) => sectionWithoutMedia(section, missing)),
      landing: Object.fromEntries(Object.entries(theme.pages.landing).map(([slug, page]) =>
        [slug, { ...page, sections: page.sections.map((section) => sectionWithoutMedia(section, missing)) }])),
      templates: Object.fromEntries(Object.entries(theme.pages.templates).map(([kind, template]) =>
        [kind, { ...template, sections: template.sections.map((section) => sectionWithoutMedia(section, missing)) }])) as StorefrontThemeDocument["pages"]["templates"],
    },
  };
}

/** Every media id the document names, each once, in document order. */
export function storefrontThemeMediaIds(theme: StorefrontThemeDocument): string[] {
  return [...new Set(storefrontThemeMediaReferences(theme).map((reference) => reference.mediaId))];
}
