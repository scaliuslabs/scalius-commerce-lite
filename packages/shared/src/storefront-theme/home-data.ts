// What the homepage sections read: product lists by source, media by id,
// the brand wall's brands and the deal countdowns' promotions, derived from
// the section list. The API reads exactly these, for the published theme in
// the homepage batch part and for a preview's stored draft on the
// token-verified preview route; callers never name reads. The storefront
// looks each section's data up by the same keys, so the two cannot drift
// apart.
import type { StorefrontProductSource, StorefrontSection } from "./sections";

/** Most products one source feeds (a 6x6 grid). */
export const HOME_PRODUCT_LIST_LIMIT = 36;
/** Distinct product sources one homepage reads; later sources render nothing. */
export const HOME_MAX_PRODUCT_LISTS = 8;
/** Images (banners, lookbook and editorial photos, side banners, cards, mosaic tiles) one homepage reads. */
export const HOME_MAX_MEDIA = 24;
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

export interface HomeProductListRequest {
  /** `storefrontProductSourceKey(source)`. */
  key: string;
  source: StorefrontProductSource;
  limit: number;
}

export interface HomeSectionRequests {
  lists: HomeProductListRequest[];
  mediaIds: string[];
  /** How many brands the brand wall reads (0: no brand wall). */
  brandLimit: number;
  /** The promotions whose real end times deal countdowns count to. */
  promotionIds: string[];
}

/** One key per source: `newest`, `on-sale`, `popular`, `collection:<id>`, `category:<id>`. */
export function storefrontProductSourceKey(source: StorefrontProductSource): string {
  if (source.kind === "collection") return `collection:${source.collectionId}`;
  if (source.kind === "category") return `category:${source.categoryId}`;
  return source.kind;
}

/** The product lists a section shows (a tabbed block has one per tab), with how many products each needs. */
export function homeSectionProductLists(section: StorefrontSection): Array<{ source: StorefrontProductSource; limit: number }> {
  switch (section.type) {
    case "product-rail":
      return [{ source: section.settings.source, limit: section.settings.limit }];
    case "product-grid":
      return [{ source: section.settings.source, limit: section.settings.columns * section.settings.rows }];
    case "deal-block":
      return [{ source: section.settings.source, limit: HOME_DEAL_LIMIT }];
    case "product-tabs":
      return section.settings.tabs.map((tab) => ({ source: tab.source, limit: section.settings.limit }));
    case "lookbook":
      return [{ source: section.settings.source, limit: HOME_LOOKBOOK_LIMIT }];
    // Daraz "Just For You": the newest products, the listing continues them.
    case "endless-grid":
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
      return section.settings.layout === "contained-banners"
        ? (section.settings.sideBanners ?? []).map((banner) => banner.mediaId)
        : [];
    case "banner":
    case "lookbook":
      return section.settings.mediaId ? [section.settings.mediaId] : [];
    case "editorial":
      return section.settings.layout === "image-with-text" && section.settings.mediaId ? [section.settings.mediaId] : [];
    case "shop-by":
      return section.settings.cards.map((card) => card.mediaId);
    case "banner-mosaic":
      return section.settings.tiles.map((tile) => tile.mediaId);
    default:
      return [];
  }
}

/**
 * Everything the sections read, in document order: one list per source
 * (the largest limit any section asks of it), each image once, the brand
 * wall's brands and the deal promotions, all capped so a homepage costs the
 * same bounded batch however it is built.
 */
export function homeSectionRequests(sections: readonly StorefrontSection[]): HomeSectionRequests {
  const lists = new Map<string, HomeProductListRequest>();
  const mediaIds = new Set<string>();
  const promotionIds = new Set<string>();
  let brandLimit = 0;
  for (const section of sections) {
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
    if (section.type === "brand-wall") brandLimit = HOME_BRAND_LIMIT;
    if (section.type === "deal-block" && section.settings.promotionId && promotionIds.size < HOME_MAX_PROMOTIONS) {
      promotionIds.add(section.settings.promotionId);
    }
  }
  return { lists: [...lists.values()], mediaIds: [...mediaIds], brandLimit, promotionIds: [...promotionIds] };
}

/** Whether the sections read anything at all (a preview with none skips the database). */
export function homeSectionRequestsEmpty(requests: HomeSectionRequests): boolean {
  return requests.lists.length === 0 && requests.mediaIds.length === 0
    && requests.brandLimit === 0 && requests.promotionIds.length === 0;
}
