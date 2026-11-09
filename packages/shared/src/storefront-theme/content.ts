// The merchant's own content inside a theme document, as opposed to its
// look: the brand (logo, its dark version, footer logo, tab icon, logo
// width), the colour scheme (scheme, dark colours, the buyers' switch), the
// announcement's words and link, the footer's words, each homepage section's
// words, pictures and picks (`STOREFRONT_SECTION_CONTENT_KEYS`), the landing
// pages and what `/` shows. Choosing another template keeps it
// (`storefrontThemeWithContent`, `carryStorefrontHome`), and "does this still
// match a template" compares looks only (`storefrontThemeLook`).
import { DEFAULT_STOREFRONT_THEME_BRAND, STOREFRONT_BRAND_IMAGE_KEYS } from "./brand";
import { storefrontVariantSpec } from "./blocks";
import { STOREFRONT_LIGHT_COLOR_SCHEME, storefrontThemeFieldBorder, storefrontTokensKeepingColorScheme } from "./tokens";
import { emptyStorefrontPageTemplates } from "./pages";
import { STOREFRONT_TEMPLATE_IDS, storefrontThemeWithReadableDarkColors, type StorefrontTemplateId, type StorefrontThemeDocument } from "./document";
import { STOREFRONT_MAX_SECTIONS, STOREFRONT_SECTION_REGISTRY, type StorefrontSection, type StorefrontSectionType } from "./sections";
import { STOREFRONT_THEME_TRANSLATION_LIMITS, type StorefrontThemeTranslation } from "./text";
import { storefrontTemplateTheme } from "./templates";

/** Block settings that are the merchant's words, by slot. */
export const STOREFRONT_BLOCK_CONTENT_KEYS = {
  topBar: ["text", "link"],
  footer: ["tagline", "about", "copyright"],
} as const;

/**
 * Section settings that are the merchant's content, by section type: what
 * moves to the new theme's section of the same type, and what a look leaves
 * out. Everything else (layout, style, columns, a skin) is the look's.
 */
export const STOREFRONT_SECTION_CONTENT_KEYS: Record<StorefrontSectionType, readonly string[]> = {
  hero: ["slides", "sideBanners"],
  "usp_strip": ["source"],
  "category_tiles": ["categoryIds", "title"],
  collections: ["collectionIds", "title"],
  "product_rail": ["title", "source"],
  "product_grid": ["title", "source"],
  "deal_block": ["title", "source", "promotionId", "mediaId"],
  "product_tabs": ["title", "tabs"],
  "shop_by": ["title", "cards"],
  "banner_mosaic": ["tiles"],
  lookbook: ["title", "mediaId", "source"],
  banner: ["heading", "text", "mediaId", "cta"],
  "brand_wall": ["title"],
  editorial: ["heading", "body", "mediaId", "columns", "quotes"],
  specifications: ["heading", "objectField", "rows"],
  faq: ["heading", "items"],
  "utility_cards": ["cards"],
  "endless_grid": ["title"],
  "seo_text": ["heading", "body"],
  "recently_viewed": ["title"],
  objects: ["heading", "typeId"],
  newsletter: ["heading", "text", "mediaId", "email", "whatsapp", "buttonLabel"],
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

/** Whether a value holds something: not absent, null, empty text or an empty list or object. */
function hasContent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * `target` with the merchant's content from `source`: each content key the
 * merchant filled (one that differs from the type's empty value) moves on its
 * own, and only where the target's settings still parse, so a key the
 * target's layout has no place for, or one the merchant left empty, stays the
 * target's. An app section takes the filled values of the same app section.
 * `moved` says whether any content moved.
 */
function withMerchantContent(target: StorefrontSection, source: StorefrontSection): { section: StorefrontSection; moved: boolean } {
  if (target.type === "app") {
    if (source.type !== "app" || source.settings.app !== target.settings.app) return { section: target, moved: false };
    const filled = Object.fromEntries(Object.entries(source.settings.values).filter(([, value]) => hasContent(value)));
    if (Object.keys(filled).length === 0) return { section: target, moved: false };
    return { section: { ...target, settings: { ...target.settings, values: { ...target.settings.values, ...structuredClone(filled) } } }, moved: true };
  }
  const entry = STOREFRONT_SECTION_REGISTRY[target.type];
  const defaults = entry.defaults as Record<string, unknown>;
  const from = source.settings as Record<string, unknown>;
  let next: StorefrontSection = target;
  let moved = false;
  for (const key of STOREFRONT_SECTION_CONTENT_KEYS[target.type]) {
    if (!(key in from) || !hasContent(from[key]) || sameValue(from[key], defaults[key])) continue;
    const candidate = { ...next, settings: { ...(next.settings as Record<string, unknown>), [key]: structuredClone(from[key]) } } as StorefrontSection;
    if (!entry.schema.safeParse(candidate).success) continue;
    next = candidate;
    moved = true;
  }
  return { section: next, moved };
}

/** `target` with its type's empty content: what a look compares. */
function withoutContent(target: StorefrontSection): StorefrontSection {
  if (target.type === "app") return target;
  const entry = STOREFRONT_SECTION_REGISTRY[target.type];
  const defaults = entry.defaults as Record<string, unknown>;
  let next: StorefrontSection = target;
  for (const key of STOREFRONT_SECTION_CONTENT_KEYS[target.type]) {
    const settings = { ...(next.settings as Record<string, unknown>) };
    if (key in defaults) settings[key] = structuredClone(defaults[key]);
    else delete settings[key];
    const candidate = { ...next, settings } as StorefrontSection;
    if (entry.schema.safeParse(candidate).success) next = candidate;
  }
  return next;
}

/** The template a document is on: the app template its look came from, else its built-in template. */
export function storefrontThemeTemplateKey(theme: Pick<StorefrontThemeDocument, "template" | "apps">): string {
  return theme.apps?.template ?? theme.template;
}

/** A built-in template's homepage as it starts, or null for an app template's key. */
export function storefrontTemplateHome(key: string): readonly StorefrontSection[] | null {
  return (STOREFRONT_TEMPLATE_IDS as readonly string[]).includes(key)
    ? storefrontTemplateTheme(key as StorefrontTemplateId).pages.home
    : null;
}

/** A section a theme switch kept from another theme, still hidden (`keptFrom`). */
export function storefrontSectionKeptHidden(section: StorefrontSection): boolean {
  return section.hidden === true && section.keptFrom !== undefined;
}

/** What pairs two sections across themes: the type, an editorial's shape, an app section's app part. */
function sectionKind(section: StorefrontSection): string {
  if (section.type === "app") return `app:${section.settings.app}`;
  if (section.type !== "editorial") return section.type;
  const { layout } = section.settings;
  return layout === "testimonial" || layout === "multicolumn" ? `editorial:${layout}` : "editorial:text";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, each]) => each !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, each]) => [key, canonical(each)]));
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** A section id free on the page: the id, then -2, -3… */
function freeSectionId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let number = 2; ; number += 1) {
    const candidate = `${id.slice(0, 36)}-${number}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The homepage a theme switch makes, and what happened to each of the merchant's sections. */
export interface StorefrontHomeCarry {
  home: StorefrontSection[];
  /** The merchant's sections whose filled-in content a section of the new homepage took (`from` theirs, `to` the new one). */
  moved: Array<{ from: string; to: string }>;
  /** The merchant's sections kept on the new homepage after its own, by their id there. */
  kept: string[];
  /** The merchant's sections the new homepage leaves out: they stay in the theme they were in. */
  left: string[];
}

/**
 * The new theme's homepage (`target`) with the merchant's (`source`). Each
 * new section pairs with the merchant's section of the same kind (same id
 * first, then in page order) and takes the content the merchant filled in
 * there, so the hero's slides, an editorial's words and quotes and a
 * newsletter's words follow their type whatever the ids; what the merchant
 * left empty stays the template's. A merchant section no new section takes stays after the new ones,
 * hidden and marked with the theme it came from (`keptFrom`), when the
 * themes differ; restyling the same theme keeps it as it was. Left out (it
 * stays in the theme it was in): a section of that theme's own homepage the
 * merchant never changed (`fromHome`; a built-in template's is known), one
 * already kept hidden from an earlier switch, and any past the section limit.
 */
export function carryStorefrontHome(
  target: readonly StorefrontSection[],
  source: readonly StorefrontSection[],
  options: { from: string; to: string; fromHome?: readonly StorefrontSection[] | null },
): StorefrontHomeCarry {
  const sameTheme = options.from === options.to;
  const fromHome = options.fromHome === undefined ? storefrontTemplateHome(options.from) : options.fromHome;
  const pairs = new Map<number, number>();
  const used = new Set<number>();
  const pair = (match: (section: StorefrontSection, candidate: StorefrontSection) => boolean) => {
    target.forEach((section, index) => {
      if (pairs.has(index)) return;
      const found = source.findIndex((candidate, at) => !used.has(at) && match(section, candidate));
      if (found < 0) return;
      pairs.set(index, found);
      used.add(found);
    });
  };
  pair((section, candidate) => candidate.id === section.id && sectionKind(candidate) === sectionKind(section));
  pair((section, candidate) => sectionKind(candidate) === sectionKind(section));
  const moved: StorefrontHomeCarry["moved"] = [];
  const home = target.map((section, index) => {
    const at = pairs.get(index);
    if (at === undefined) return structuredClone(section);
    const carried = withMerchantContent(structuredClone(section), source[at]!);
    if (carried.moved) moved.push({ from: source[at]!.id, to: section.id });
    return carried.section;
  });
  const taken = new Set(home.map((section) => section.id));
  const kept: string[] = [];
  const left: string[] = [];
  source.forEach((section, index) => {
    if (used.has(index)) return;
    const untouched = !sameTheme && fromHome?.some((own) => own.id === section.id && sameValue(own, section));
    if (untouched || (!sameTheme && storefrontSectionKeptHidden(section)) || home.length >= STOREFRONT_MAX_SECTIONS) {
      left.push(section.id);
      return;
    }
    const id = freeSectionId(section.id, taken);
    taken.add(id);
    kept.push(id);
    home.push(sameTheme ? { ...structuredClone(section), id } : { ...structuredClone(section), id, hidden: true, keptFrom: options.from } as StorefrontSection);
  });
  return { home, moved, kept, left };
}

/** Translations of both documents, row by row (language and market); `preferred`'s words win and fill first. */
function mergedTranslations(
  preferred: readonly StorefrontThemeTranslation[] | undefined,
  other: readonly StorefrontThemeTranslation[] | undefined,
): StorefrontThemeTranslation[] | undefined {
  if (!other?.length) return preferred ? structuredClone([...preferred]) : undefined;
  if (!preferred?.length) return structuredClone([...other]);
  const rows = structuredClone([...preferred]);
  for (const row of other) {
    const same = rows.find((each) => each.locale === row.locale && each.marketId === row.marketId);
    if (!same) {
      if (rows.length < STOREFRONT_THEME_TRANSLATION_LIMITS.rows) rows.push(structuredClone(row));
      continue;
    }
    for (const [words, translation] of Object.entries(row.fields)) {
      if (Object.keys(same.fields).length >= STOREFRONT_THEME_TRANSLATION_LIMITS.fields) break;
      if (!(words in same.fields)) same.fields[words] = translation;
    }
  }
  return rows;
}

/**
 * `target`'s look with `source`'s store content and `home` as the homepage:
 * the brand and home mode, the colour scheme, the announcement and footer
 * words (where the target's variants carry them), the landing pages, the
 * sections around the fixed parts and the translations (a remembered design's
 * own fill in behind the store's).
 */
function lookWithContent(target: StorefrontThemeDocument, source: StorefrontThemeDocument, home: StorefrontSection[]): StorefrontThemeDocument {
  const { translations: own, ...look } = target;
  const translations = mergedTranslations(source.translations, own);
  return storefrontThemeWithReadableDarkColors({
    ...look,
    // The colour scheme is the merchant's (a look that shows its own dark colours brings them).
    tokens: storefrontTokensKeepingColorScheme(target.tokens, source.tokens),
    // The merchant's translations are content: keyed by their words, they follow them into the new look.
    ...(translations ? { translations } : {}),
    brand: structuredClone(source.brand),
    blocks: {
      ...target.blocks,
      topBar: withBlockContent("topBar", target.blocks.topBar, source.blocks.topBar),
      footer: withBlockContent("footer", target.blocks.footer, source.blocks.footer),
    } as StorefrontThemeDocument["blocks"],
    pages: {
      ...target.pages,
      home,
      homeMode: structuredClone(source.pages.homeMode),
      landing: structuredClone(source.pages.landing),
      // The merchant's sections around the fixed parts are content too.
      templates: structuredClone(source.pages.templates),
    },
  });
}

/**
 * A design the store had on another theme (`design`, a whole document) back,
 * with the store's content now (`current`): the design's look, homepage and
 * app parts, the current brand, words, landing pages and colour scheme.
 */
export function storefrontThemeWithDesign(design: StorefrontThemeDocument, current: StorefrontThemeDocument): StorefrontThemeDocument {
  return lookWithContent(design, current, structuredClone(design.pages.home));
}

/** `storefrontThemeWithContent` with what happened to the merchant's homepage sections. */
export function storefrontThemeWithContentCarry(
  target: StorefrontThemeDocument,
  source: StorefrontThemeDocument,
  fromHome?: readonly StorefrontSection[] | null,
): { theme: StorefrontThemeDocument; carry: StorefrontHomeCarry } {
  const carry = carryStorefrontHome(target.pages.home, source.pages.home, {
    from: storefrontThemeTemplateKey(source),
    to: storefrontThemeTemplateKey(target),
    fromHome,
  });
  return { theme: lookWithContent(target, source, carry.home), carry };
}

/**
 * `target` (a built-in template's document) with `source`'s content: its
 * store content (`lookWithContent`) and its homepage carried into the
 * target's (`carryStorefrontHome`). Pass null to clear the content: every
 * section's content becomes its type's empty content, as a look compares it.
 */
export function storefrontThemeWithContent(
  target: StorefrontThemeDocument,
  source: StorefrontThemeDocument | null,
): StorefrontThemeDocument {
  if (source) return storefrontThemeWithContentCarry(target, source).theme;
  const { translations: _look, ...look } = target;
  return storefrontThemeWithReadableDarkColors({
    ...look,
    tokens: { ...target.tokens, ...STOREFRONT_LIGHT_COLOR_SCHEME },
    brand: { ...DEFAULT_STOREFRONT_THEME_BRAND },
    blocks: {
      ...target.blocks,
      topBar: withBlockContent("topBar", target.blocks.topBar, null),
      footer: withBlockContent("footer", target.blocks.footer, null),
    } as StorefrontThemeDocument["blocks"],
    pages: {
      ...target.pages,
      home: target.pages.home.map(withoutContent),
      homeMode: { kind: "sections" },
      landing: {},
      templates: emptyStorefrontPageTemplates(),
    },
  });
}

/**
 * The document's look: everything but its content (content reset to empty),
 * without the sections a theme switch kept hidden from another theme. The
 * field border reads as the palettes give it now, so a store saved from a
 * template before its border was darkened to show (3:1) still matches it.
 */
export function storefrontThemeLook(theme: StorefrontThemeDocument): StorefrontThemeDocument {
  const own = { ...theme, pages: { ...theme.pages, home: theme.pages.home.filter((section) => !storefrontSectionKeptHidden(section)) } };
  const look = storefrontThemeWithContent(own, null);
  const { colors } = look.tokens;
  return { ...look, tokens: { ...look.tokens, colors: { ...colors, input: storefrontThemeFieldBorder(colors) } } };
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
    case "deal_block":
    case "newsletter":
      return ref("mediaId", section.settings.mediaId);
    case "editorial":
      return section.settings.layout === "image-with-text" ? ref("mediaId", section.settings.mediaId) : [];
    case "shop_by":
      return section.settings.cards.flatMap((card, index) => ref(`cards.${index}.mediaId`, card.mediaId));
    case "banner_mosaic":
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
  const brand = STOREFRONT_BRAND_IMAGE_KEYS.flatMap((key) =>
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
    case "deal_block":
    case "newsletter":
      return gone(section.settings.mediaId) ? { ...section, settings: { ...section.settings, mediaId: null } } as StorefrontSection : section;
    case "editorial":
      return section.settings.layout === "image-with-text" && gone(section.settings.mediaId)
        ? { ...section, settings: { ...section.settings, mediaId: null } }
        : section;
    case "shop_by":
      return { ...section, settings: { ...section.settings, cards: section.settings.cards.filter((card) => !gone(card.mediaId)) } };
    case "banner_mosaic":
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
  for (const key of STOREFRONT_BRAND_IMAGE_KEYS) {
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
