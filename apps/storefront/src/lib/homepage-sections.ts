/**
 * The homepage section library's data rules: what each section shows from
 * the homepage read (one batch part; the API reads what
 * `homeSectionRequests` names), whether it has anything to show, which
 * section leads the page, and how consecutive banners share a row. A
 * section without data renders nothing: no placeholders, no zero states.
 * An app section (`type: "app"`) shows what its app drew into the same
 * read, and nothing when the app drew nothing.
 */
import {
  HOME_COLLECTIONS_FALLBACK_LIMIT,
  HOME_DEAL_LIMIT,
  HOME_LOOKBOOK_LIMIT,
  homeSectionProductLists,
  storefrontCategoryTilesMinimum,
  storefrontProductSourceKey,
  storefrontSectionNeedsContent,
  storefrontSectionRenderer,
  type StorefrontProductSource,
  type StorefrontSection,
  type StorefrontSectionOf,
} from "@scalius/shared/storefront-theme";
import type { CollectionWithProducts, Product } from "@/lib/api";
import type {
  HomepageBrand,
  HomepageCategory,
  HomepageMediaAsset,
  HomepageProduct,
  HomepageProductList,
  HomepageSectionData,
} from "@/lib/api/storefront";
import type { DeliveryFact } from "@/lib/delivery-facts";
import { resolveHomepageHero, type ResolvedHomepageHero } from "@/lib/homepage-hero";
import { readHomepageAppSurfaces, type HomepageAppSurface } from "@/lib/app-surfaces";
import { storefrontCopy, type StorefrontLanguage } from "@/lib/storefront-copy";
import type { PluginHead } from "@scalius/shared/plugins/storefront";

/**
 * Everything the homepage sections draw from, looked up by source key,
 * media id, category id, collection id and promotion id.
 */
export interface HomepageContent {
  deliveryFacts: DeliveryFact[];
  lists: ReadonlyMap<string, HomepageProductList>;
  media: ReadonlyMap<string, HomepageMediaAsset>;
  /** The category tiles' published categories, by id. */
  categories: ReadonlyMap<string, HomepageCategory>;
  /** The collections sections' active collections, by id. */
  collections: ReadonlyMap<string, CollectionWithProducts>;
  brands: readonly HomepageBrand[];
  /** Running promotions' end times, by promotion id. */
  promotionEnds: ReadonlyMap<string, string>;
  /** The product a product homepage opens on, while it is public. */
  homeProduct: HomepageProduct | null;
  /** What app sections drew (sanitized by the API), by section id; absent or missing: nothing. */
  apps?: ReadonlyMap<string, HomepageAppSurface>;
  /** The store's language for default titles (English when absent). */
  language?: StorefrontLanguage;
}

export const EMPTY_HOMEPAGE_SECTION_DATA: HomepageSectionData = {
  lists: [],
  media: [],
  brands: [],
  promotions: [],
  categories: [],
  collections: [],
  homeProduct: null,
};

/** The section data (published, or a preview's draft) keyed for the sections, with the store's delivery facts. */
export function homepageContent(
  data: Partial<HomepageSectionData> | null | undefined,
  deliveryFacts: DeliveryFact[],
): HomepageContent {
  return {
    deliveryFacts,
    lists: new Map((data?.lists ?? []).map((list) => [list.key, list])),
    media: new Map((data?.media ?? []).map((asset) => [asset.id, asset])),
    categories: new Map((data?.categories ?? []).map((category) => [category.id, category])),
    collections: new Map((data?.collections ?? []).map((collection) => [collection.id, collection])),
    brands: data?.brands ?? [],
    promotionEnds: new Map((data?.promotions ?? []).map((promotion) => [promotion.id, promotion.endsAt])),
    homeProduct: data?.homeProduct ?? null,
    apps: readHomepageAppSurfaces(data?.apps),
  };
}

/** What an app section drew, or null when its app drew nothing (the section then renders nothing). */
export function homepageAppSurface(
  section: StorefrontSection,
  content: Pick<HomepageContent, "apps">,
): HomepageAppSurface | null {
  return section.type === "app" ? content.apps?.get(section.id) ?? null : null;
}

/** The head tags of the app sections that render, in page order (the homepage head carries them). */
export function homepageAppHeads(
  sections: readonly StorefrontSection[],
  content: HomepageContent,
): PluginHead[] {
  return sections.flatMap((section) => {
    const surface = section.hidden ? null : homepageAppSurface(section, content);
    return surface ? [surface.head] : [];
  });
}

/** A hero section's slides per viewport (slides whose image did not resolve are left out). */
export function homepageHero(section: StorefrontSectionOf<"hero">, content: HomepageContent): ResolvedHomepageHero {
  return resolveHomepageHero(section.settings.slides, (id) => homepageMedia(content, id));
}

/** The title category tiles show: the section's own, else "Shop by category". */
export function homepageCategoryTilesTitle(section: StorefrontSectionOf<"category-tiles">, language: StorefrontLanguage = "en"): string {
  return section.settings.title.trim() || storefrontCopy(language).home.shopByCategory;
}

/**
 * Columns for a grid of `count` tiles that leaves no stranded row: the
 * widest count in `min`..`max` that divides evenly, else the one whose last
 * row is fullest (12 tiles: 6 or 4 across, never 8 + 4; 7 tiles: 7).
 */
export function balancedColumns(count: number, max: number, min = 2): number {
  const widest = Math.max(1, Math.min(max, count));
  let best = widest;
  let bestFill = -1;
  for (let columns = widest; columns >= Math.min(min, widest); columns -= 1) {
    const fill = (count % columns || columns) / columns;
    if (fill > bestFill + 1e-9) {
      best = columns;
      bestFill = fill;
    }
  }
  return best;
}

/** A category-tiles section's categories, in the section's order (ones that are not public are skipped). */
export function homepageCategoryTiles(
  section: StorefrontSectionOf<"category-tiles">,
  content: HomepageContent,
): HomepageCategory[] {
  return section.settings.categoryIds.flatMap((id) => {
    const category = content.categories.get(id);
    return category ? [category] : [];
  });
}

/** Whether a homepage collection renders (a grid needs products or its featured product). */
export function collectionShowsProducts(collection: CollectionWithProducts): boolean {
  const products = collection.products?.length ?? 0;
  if (collection.presentation === "carousel") return products > 0;
  if (collection.presentation === "grid") return products > 0 || Boolean(collection.featuredProduct);
  return false;
}

/** A plain-text body as paragraphs: blank lines separate them. */
export function richTextParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

/**
 * Long SEO copy as blocks (heading + paragraph pairs): a paragraph whose
 * first line starts with "## " or "### " opens with that line as a
 * subheading. Markdown markers never print.
 */
export function seoTextBlocks(body: string): Array<{ heading: string | null; text: string }> {
  return richTextParagraphs(body).map((paragraph) => {
    const [first = "", ...rest] = paragraph.split("\n");
    const marker = /^#{2,3}(?:\s|$)/.exec(first);
    if (!marker) return { heading: null, text: paragraph };
    return { heading: first.slice(marker[0].length).trim() || null, text: rest.join("\n").trim() };
  }).filter((block) => block.heading || block.text);
}

/** A product list as a section shows it: its cards, title and "View all" link. */
export interface HomepageSectionProducts {
  products: Product[];
  /** The merchant's title, else one that says what the list is. */
  title: string;
  /** Where the whole list lives, when a listing shows it. */
  href: string | null;
}

function sourceTitleAndHref(
  source: StorefrontProductSource,
  list: HomepageProductList | undefined,
  language: StorefrontLanguage,
): { title: string; href: string | null } | null {
  const copy = storefrontCopy(language).home;
  switch (source.kind) {
    case "newest":
      return { title: copy.newArrivals, href: "/search" };
    case "on-sale":
      return { title: copy.onSale, href: "/search?hasDiscount=true" };
    // No listing sorts by popularity, so the list has no "View all".
    case "popular":
      return { title: copy.popular, href: null };
    case "collection":
      return list?.collection
        ? { title: list.collection.title, href: `/collections/${encodeURIComponent(list.collection.id)}` }
        : null;
    case "category":
      return list?.category
        ? {
            title: list.category.name,
            href: list.category.canonicalPath || `/categories/${encodeURIComponent(list.category.slug)}`,
          }
        : null;
  }
}

function sourceProducts(
  source: StorefrontProductSource,
  limit: number,
  content: HomepageContent,
): { products: Product[]; title: string; href: string | null } | null {
  const list = content.lists.get(storefrontProductSourceKey(source));
  const named = sourceTitleAndHref(source, list, content.language ?? "en");
  const products = (list?.products ?? []).slice(0, limit) as Product[];
  return named && products.length > 0 ? { products, ...named } : null;
}

/** Products a single-list section shows from its source (its first N), or null when it has none. */
export function homepageSectionProducts(
  section: StorefrontSection,
  content: HomepageContent,
): HomepageSectionProducts | null {
  if (section.type === "collections" || section.type === "product-tabs") return null;
  const [request] = homeSectionProductLists(section);
  if (!request) return null;
  const shown = sourceProducts(request.source, request.limit, content);
  if (!shown) return null;
  const title = "title" in section.settings ? section.settings.title.trim() : "";
  return { products: shown.products, title: title || shown.title, href: shown.href };
}

/** One tab of a tabbed product block: its label, cards and "View all". */
export interface HomepageProductTab extends HomepageSectionProducts {
  key: string;
}

/** The tabs that have products, in order; a tab without a label is named after its source. */
export function homepageSectionTabs(
  section: StorefrontSectionOf<"product-tabs">,
  content: HomepageContent,
): HomepageProductTab[] {
  const seen = new Set<string>();
  return section.settings.tabs.flatMap((tab) => {
    const key = storefrontProductSourceKey(tab.source);
    if (seen.has(key)) return [];
    seen.add(key);
    const shown = sourceProducts(tab.source, section.settings.limit, content);
    return shown ? [{ key, products: shown.products, title: tab.label.trim() || shown.title, href: shown.href }] : [];
  });
}

/** A collections section's collections that show products, in the section's order. */
export function homepageCollections(
  section: StorefrontSectionOf<"collections">,
  content: HomepageContent,
): CollectionWithProducts[] {
  return section.settings.collectionIds.flatMap((id) => {
    const collection = content.collections.get(id);
    return collection && collectionShowsProducts(collection) ? [collection] : [];
  });
}

/** The newest products a collections section shows when none of its collections shows products. */
export function homepageCollectionsFallback(
  section: StorefrontSectionOf<"collections">,
  content: HomepageContent,
): Product[] {
  if (homepageCollections(section, content).length > 0) return [];
  return (content.lists.get("newest")?.products ?? []).slice(0, HOME_COLLECTIONS_FALLBACK_LIMIT) as Product[];
}

export function homepageMedia(content: HomepageContent, id: string | null | undefined): HomepageMediaAsset | null {
  return id ? content.media.get(id) ?? null : null;
}

/**
 * A deal's end: its promotion's stored end time while that promotion runs
 * and the end is still ahead. A countdown only ever counts to a real end.
 */
export function dealEndsAt(
  section: StorefrontSectionOf<"deal-block">,
  content: Pick<HomepageContent, "promotionEnds">,
  now = Date.now(),
): string | null {
  const id = section.settings.promotionId;
  const endsAt = id ? content.promotionEnds.get(id) : undefined;
  return endsAt && Date.parse(endsAt) > now ? endsAt : null;
}

/** Where a brand-wall brand links: its canonical path, else its brand page. */
export function homepageBrandHref(brand: Pick<HomepageBrand, "slug" | "canonicalPath">): string {
  return brand.canonicalPath || `/brands/${encodeURIComponent(brand.slug)}`;
}

/** The delivery-facts strip needs two facts to be a strip. */
export const HOME_USP_MIN_FACTS = 2;

/** A brand wall needs four brands to be a wall (the section's fit rule reads the same count). */
export const HOME_BRAND_WALL_MIN = 4;

export { HOME_DEAL_LIMIT, HOME_LOOKBOOK_LIMIT };

function textPresent(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => Boolean(value?.trim()));
}

/** A "shop by" section's cards whose photos exist, each with its photo. */
export function homepageShopByCards(section: StorefrontSectionOf<"shop-by">, content: HomepageContent) {
  return section.settings.cards.flatMap((card) => {
    const photo = homepageMedia(content, card.mediaId);
    return photo ? [{ ...card, photo }] : [];
  });
}

/** A banner mosaic's tiles whose photos exist, each with its photo. */
export function homepageMosaicTiles(section: StorefrontSectionOf<"banner-mosaic">, content: HomepageContent) {
  return section.settings.tiles.flatMap((tile) => {
    const photo = homepageMedia(content, tile.mediaId);
    return photo ? [{ ...tile, photo }] : [];
  });
}

/** Whether a section has anything to show on this store (sections without data render nothing). */
export function homepageSectionRenders(section: StorefrontSection, content: HomepageContent): boolean {
  if (section.hidden) return false;
  // An app section has no platform renderer: it shows what its app drew.
  if (section.type === "app") return homepageAppSurface(section, content) !== null;
  if (storefrontSectionRenderer(section) === null || storefrontSectionNeedsContent(section)) return false;
  switch (section.type) {
    case "product-tabs":
      return homepageSectionTabs(section, content).length > 0;
    case "shop-by":
      return homepageShopByCards(section, content).length > 0;
    case "banner-mosaic":
      return homepageMosaicTiles(section, content).length > 0;
    case "brand-wall":
      return content.brands.length >= HOME_BRAND_WALL_MIN;
    // A client island: it fills itself from this browser's own history
    // before it paints, and stays hidden (no box) for a first visit.
    case "recently-viewed":
      return true;
    case "hero":
      return homepageHero(section, content).desktop.length > 0;
    case "usp-strip":
      return section.settings.source.kind === "delivery-facts"
        ? content.deliveryFacts.length >= HOME_USP_MIN_FACTS
        : section.settings.source.items.length > 0;
    case "category-tiles":
      // Photo tiles are a rail (one category is enough there); the denser
      // styles need two to be a choice at all.
      return homepageCategoryTiles(section, content).length >= storefrontCategoryTilesMinimum(section.settings.style);
    case "collections":
      return homepageCollections(section, content).length > 0 || homepageCollectionsFallback(section, content).length > 0;
    case "product-rail":
    case "product-grid":
    case "deal-block":
    case "lookbook":
    case "endless-grid":
      return homepageSectionProducts(section, content) !== null;
    case "banner":
      return homepageMedia(content, section.settings.mediaId) !== null
        || textPresent(section.settings.heading, section.settings.text);
    case "editorial":
      switch (section.settings.layout) {
        case "rich-text":
          return textPresent(section.settings.heading) || richTextParagraphs(section.settings.body).length > 0;
        case "image-with-text":
          return homepageMedia(content, section.settings.mediaId) !== null
            || textPresent(section.settings.heading, section.settings.body);
        case "multicolumn":
          return section.settings.columns.some((column) => textPresent(column.title, column.text));
        case "testimonial":
          return section.settings.quotes.length > 0;
        default:
          return false;
      }
    case "faq":
      return section.settings.items.length > 0;
    case "utility-cards":
      return section.settings.cards.length > 0;
    case "seo-text":
      return seoTextBlocks(section.settings.body).length > 0;
    // The signup form reads no store data: it always has its form and words.
    case "newsletter":
      return true;
    default:
      return false;
  }
}

/**
 * Whether the section opens with a large photo that can be the page's
 * largest paint. Text strips, category thumbnails and the FAQ sit above
 * such a photo without pushing it below the fold, so they never lead.
 */
function leadsWithPhoto(section: StorefrontSection, content: HomepageContent): boolean {
  switch (section.type) {
    case "hero":
    case "collections":
    case "product-rail":
    case "product-grid":
    case "deal-block":
    case "product-tabs":
    case "lookbook":
    case "endless-grid":
    case "shop-by":
    case "banner-mosaic":
      return true;
    case "banner":
      return homepageMedia(content, section.settings.mediaId) !== null;
    case "editorial":
      return section.settings.layout === "image-with-text" && homepageMedia(content, section.settings.mediaId) !== null;
    default:
      return false;
  }
}

/**
 * The section holding the first large photo buyers see. Only a leading hero
 * is preloaded; a leading product list or banner loads its first photos
 * eagerly instead. Sections without data never lead.
 */
export function homepageLeadSection(
  sections: readonly StorefrontSection[],
  content: HomepageContent,
  categoryTilesLead = false,
): StorefrontSection | null {
  return sections.find((section) =>
    homepageSectionRenders(section, content) &&
    (leadsWithPhoto(section, content) || (categoryTilesLead && section.type === "category-tiles" && homepageCategoryTiles(section, content).some((category) => Boolean(category.imageUrl))))
  ) ?? null;
}

/** Move a saved hero after the first visible category tiles on phones, if requested. */
export function homepagePhoneSections(
  sections: readonly StorefrontSection[],
  content: HomepageContent,
): readonly StorefrontSection[] {
  const heroIndex = sections.findIndex((section) => section.type === "hero" && section.settings.phonePlacement === "after-categories" && homepageSectionRenders(section, content));
  const categoryIndex = sections.findIndex((section) => section.type === "category-tiles" && homepageSectionRenders(section, content));
  if (heroIndex < 0 || categoryIndex <= heroIndex) return sections;
  const ordered = [...sections];
  const [hero] = ordered.splice(heroIndex, 1);
  ordered.splice(categoryIndex, 0, hero!);
  return ordered;
}

/**
 * How a banner row draws: a lone banner fills the row, and a short run of
 * four-up banners spreads over the row instead of leaving it part empty.
 */
export function bannerRowLayout(layout: "two-up" | "four-up", count: number): "full" | "two-up" | "three-up" | "four-up" {
  if (count <= 1) return "full";
  if (layout === "two-up" || count === 2) return "two-up";
  return count === 3 ? "three-up" : "four-up";
}

/** What renders, in order: one entry per section, consecutive two-up / four-up banners in one row. */
export type HomepageRenderUnit =
  | { kind: "section"; section: StorefrontSection }
  | { kind: "banners"; layout: "two-up" | "four-up"; sections: Array<StorefrontSectionOf<"banner">> };

export function homepageRenderUnits(
  sections: readonly StorefrontSection[],
  content: HomepageContent,
): HomepageRenderUnit[] {
  const units: HomepageRenderUnit[] = [];
  for (const section of sections) {
    if (!homepageSectionRenders(section, content)) continue;
    if (section.type === "banner" && section.settings.layout !== "full") {
      const last = units.at(-1);
      const size = section.settings.layout === "two-up" ? 2 : 4;
      if (last?.kind === "banners" && last.layout === section.settings.layout && last.sections.length < size) {
        last.sections.push(section);
      } else {
        units.push({ kind: "banners", layout: section.settings.layout, sections: [section] });
      }
      continue;
    }
    units.push({ kind: "section", section });
  }
  return units;
}
