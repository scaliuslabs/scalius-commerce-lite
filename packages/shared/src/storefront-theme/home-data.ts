import { collectObjectBindingRequests, type SettingBindings } from "./bindings";
// What the homepage sections read: product lists by source, media by id
// (hero slides included), the category tiles' categories, the collections
// section's collections, the brand wall's brands, the deal countdowns'
// promotions and the product a product homepage opens on, derived from the
// page. The API reads exactly these, for the published theme in the homepage
// batch part and for a preview's stored draft on the token-verified preview
// route; callers never name reads. The storefront looks each section's data
// up by the same keys, so the two cannot drift apart.
import type { PluginSettingValue } from "../plugins/settings-schema";
import { PLUGIN_HOME_SECTIONS_MAX, parsePluginSurfaceKey } from "../plugins/storefront";
import type { StorefrontHomeMode } from "./document";
import { storefrontVisibleSection, type StorefrontProductSource, type StorefrontSection } from "./sections";

/** Most products one source feeds (a 6x6 grid). */
export const HOME_PRODUCT_LIST_LIMIT = 36;
/** Distinct product sources one homepage reads; later sources render nothing. */
export const HOME_MAX_PRODUCT_LISTS = 8;
/** Images (hero slides, banners, lookbook and editorial photos, side banners, cards, mosaic tiles) one homepage reads. */
export const HOME_MAX_MEDIA = 40;
/** Categories the category tiles of one homepage read, all sections together. */
export const HOME_MAX_CATEGORIES = 24;
/** Collections the collections sections of one homepage read, all sections together. */
export const HOME_MAX_COLLECTIONS = 8;
/** A deal block's cards (Daraz shows 6 per row). */
export const HOME_DEAL_LIMIT = 12;
/** A lookbook's thumbnails: 4x2 at most, the last one "View more" when there is more (Fabrilife). */
export const HOME_LOOKBOOK_LIMIT = 8;
/** New arrivals a collections section shows when the store has no homepage collection. */
export const HOME_COLLECTIONS_FALLBACK_LIMIT = 8;
/** Brands a brand wall shows (Apple Gadgets' rail, eBay's grid). */
export const HOME_BRAND_LIMIT = 24;
/** Promotions whose end times the deal countdowns read. */
export const HOME_MAX_PROMOTIONS = 4;
/** Object content types the Objects sections of one page read. */
export const HOME_MAX_OBJECT_TYPES = 4;

export interface HomeProductListRequest {
  /** `storefrontProductSourceKey(source)`. */
  key: string;
  source: StorefrontProductSource;
  limit: number;
}

export interface HomeSectionRequests {
  lists: HomeProductListRequest[];
  mediaIds: string[];
  /** The category tiles' categories, in document order. */
  categoryIds: string[];
  /** The collections sections' collections, in document order. */
  collectionIds: string[];
  /** How many brands the brand wall reads (0: no brand wall). */
  brandLimit: number;
  /** The promotions whose real end times deal countdowns count to. */
  promotionIds: string[];
  /** The product a product homepage opens on (null: the sections). */
  homeProductId: string | null;
  /** App sections in document order (`PLUGIN_HOME_SECTIONS_MAX` at most); the API asks each app to draw its own. */
  apps?: HomeAppSectionRequest[];
  /** The Objects sections' content types, each with the most entries any of its sections shows. */
  objects?: HomeObjectRequest[];
  bindingObjects?: ReturnType<typeof collectObjectBindingRequests>;
}

/** One content type a Objects section shows, and how many entries. */
export interface HomeObjectRequest {
  typeId: string;
  limit: number;
}

/** One app section the homepage shows: which app and type, and the merchant's values. */
export interface HomeAppSectionRequest {
  sectionId: string;
  pluginId: string;
  type: string;
  values: Record<string, PluginSettingValue>;
  bindings?: SettingBindings;
}

/** One key per source: `newest`, `on-sale`, `popular`, `collection:<id>`, `category:<id>`. */
export function storefrontProductSourceKey(source: StorefrontProductSource): string {
  if (source.kind === "collection") return `collection:${source.collectionId}`;
  if (source.kind === "category") return `category:${source.categoryId}`;
  return source.kind;
}

/** The source a `storefrontProductSourceKey` names (an app's `products` setting value); null for anything else. */
export function parseStorefrontProductSourceKey(key: string): StorefrontProductSource | null {
  if (key === "newest" || key === "on-sale" || key === "popular") return { kind: key };
  const match = /^(collection|category):([A-Za-z0-9_-]{1,64})$/.exec(key);
  if (!match) return null;
  return match[1] === "collection" ? { kind: "collection", collectionId: match[2]! } : { kind: "category", categoryId: match[2]! };
}

/** The product lists a section shows (a tabbed block has one per tab), with how many products each needs. */
export function homeSectionProductLists(section: StorefrontSection): Array<{ source: StorefrontProductSource; limit: number }> {
  switch (section.type) {
    case "product_rail":
      return [{ source: section.settings.source, limit: section.settings.limit }];
    case "product_grid":
      return [{ source: section.settings.source, limit: section.settings.columns * section.settings.rows }];
    case "deal_block":
      return [{ source: section.settings.source, limit: HOME_DEAL_LIMIT }];
    case "product_tabs":
      return section.settings.tabs.map((tab) => ({ source: tab.source, limit: section.settings.limit }));
    case "lookbook":
      return [{ source: section.settings.source, limit: HOME_LOOKBOOK_LIMIT }];
    // Daraz "Just For You": the newest products, the listing continues them.
    case "endless_grid":
      return [{ source: { kind: "newest" }, limit: section.settings.pageSize }];
    // A store without homepage collections shows its newest products instead.
    case "collections":
      return [{ source: { kind: "newest" }, limit: HOME_COLLECTIONS_FALLBACK_LIMIT }];
    default:
      return [];
  }
}

/** The images a section shows, by media id. */
export function homeSectionMediaIds(section: StorefrontSection): string[] {
  switch (section.type) {
    case "hero":
      return [
        ...section.settings.slides.flatMap((slide) => slide.phoneImage ? [slide.image, slide.phoneImage] : [slide.image]),
        ...(section.settings.layout === "contained-banners"
          ? (section.settings.sideBanners ?? []).map((banner) => banner.mediaId)
          : []),
      ];
    case "banner":
    case "lookbook":
    case "deal_block":
    case "newsletter":
      return section.settings.mediaId ? [section.settings.mediaId] : [];
    case "editorial":
      return section.settings.layout === "image-with-text" && section.settings.mediaId ? [section.settings.mediaId] : [];
    case "shop_by":
      return section.settings.cards.map((card) => card.mediaId);
    case "banner_mosaic":
      return section.settings.tiles.map((tile) => tile.mediaId);
    default:
      return [];
  }
}

/**
 * Whether the sections show the store's delivery facts (a delivery-facts
 * strip), so the storefront reads shipping and checkout settings only when
 * one does.
 */
export function homeSectionsShowDeliveryFacts(sections: readonly StorefrontSection[]): boolean {
  return sections.some((section) => !section.hidden && section.type === "usp_strip" && section.settings.source.kind === "delivery-facts");
}

/**
 * Everything the page reads, in document order: one list per source (the
 * largest limit any section asks of it), each image, category and
 * collection once, the brand wall's brands, the deal promotions and a
 * product homepage's product, all capped so a homepage costs the same
 * bounded batch however it is built.
 */
export function homeSectionRequests(
  sections: readonly StorefrontSection[],
  homeMode: StorefrontHomeMode = { kind: "sections" },
): HomeSectionRequests {
  const lists = new Map<string, HomeProductListRequest>();
  const mediaIds = new Set<string>();
  const categoryIds = new Set<string>();
  const collectionIds = new Set<string>();
  const promotionIds = new Set<string>();
  const apps: HomeAppSectionRequest[] = [];
  const objects = new Map<string, HomeObjectRequest>();
  let brandLimit = 0;
  for (const shown of sections) {
    if (shown.hidden) continue;
    // Hidden blocks read nothing (a hidden slide's image, a hidden tab's products).
    const section = storefrontVisibleSection(shown);
    if (section.type === "app") {
      const key = parsePluginSurfaceKey(section.settings.app);
      if (key && apps.length < PLUGIN_HOME_SECTIONS_MAX) {
        apps.push({ sectionId: section.id, pluginId: key.pluginId, type: key.type, values: section.settings.values, bindings: section.bindings });
      }
      continue;
    }
    for (const list of homeSectionProductLists(section)) {
      const key = storefrontProductSourceKey(list.source);
      const limit = Math.min(list.limit, HOME_PRODUCT_LIST_LIMIT);
      const existing = lists.get(key);
      if (existing) existing.limit = Math.max(existing.limit, limit);
      else if (lists.size < HOME_MAX_PRODUCT_LISTS) lists.set(key, { key, source: list.source, limit });
    }
    for (const id of homeSectionMediaIds(section)) {
      if (mediaIds.size < HOME_MAX_MEDIA) mediaIds.add(id);
    }
    if (section.type === "category_tiles") {
      for (const id of section.settings.categoryIds) if (categoryIds.size < HOME_MAX_CATEGORIES) categoryIds.add(id);
    }
    if (section.type === "collections") {
      for (const id of section.settings.collectionIds) if (collectionIds.size < HOME_MAX_COLLECTIONS) collectionIds.add(id);
    }
    if (section.type === "brand_wall") brandLimit = HOME_BRAND_LIMIT;
    if (section.type === "objects" && section.settings.typeId) {
      const existing = objects.get(section.settings.typeId);
      if (existing) existing.limit = Math.max(existing.limit, section.settings.limit);
      else if (objects.size < HOME_MAX_OBJECT_TYPES) {
        objects.set(section.settings.typeId, { typeId: section.settings.typeId, limit: section.settings.limit });
      }
    }
    if (section.type === "deal_block" && section.settings.promotionId && promotionIds.size < HOME_MAX_PROMOTIONS) {
      promotionIds.add(section.settings.promotionId);
    }
  }
  return {
    lists: [...lists.values()],
    mediaIds: [...mediaIds],
    categoryIds: [...categoryIds],
    collectionIds: [...collectionIds],
    brandLimit,
    promotionIds: [...promotionIds],
    homeProductId: homeMode.kind === "product" ? homeMode.productId : null,
    apps,
    objects: [...objects.values()],
    bindingObjects: collectObjectBindingRequests(sections.filter((section) => !section.hidden)),
  };
}

/** Whether the page reads anything at all (a preview with none skips the database). */
export function homeSectionRequestsEmpty(requests: HomeSectionRequests): boolean {
  return requests.lists.length === 0 && requests.mediaIds.length === 0
    && requests.categoryIds.length === 0 && requests.collectionIds.length === 0
    && requests.brandLimit === 0 && requests.promotionIds.length === 0
    && requests.homeProductId === null && (requests.apps ?? []).length === 0
    && (requests.objects ?? []).length === 0 && (requests.bindingObjects ?? []).length === 0;
}
