// What the homepage sections read: product lists by source and media by id,
// derived from the section list. The API reads exactly these in the
// homepage batch part (from the published theme, or from the query a
// preview sends), and the storefront looks each section's data up by the
// same keys, so the two cannot drift apart.
import type { StorefrontProductSource, StorefrontSection } from "./sections";

/** Most products one source feeds (a 6x6 grid). */
export const HOME_PRODUCT_LIST_LIMIT = 36;
/** Distinct product sources one homepage reads; later sources render nothing. */
export const HOME_MAX_PRODUCT_LISTS = 8;
/** Images (banners, lookbook and editorial photos, side banners) one homepage reads. */
export const HOME_MAX_MEDIA = 24;
/** A deal block's cards (Daraz shows 6 per row). */
export const HOME_DEAL_LIMIT = 12;
/** A lookbook's thumbnails: 4x2 at most, the last one "View more" when there is more (Fabrilife). */
export const HOME_LOOKBOOK_LIMIT = 8;
/** New arrivals a collections section shows when the store has no homepage collection. */
export const HOME_COLLECTIONS_FALLBACK_LIMIT = 8;

export const HOME_PRODUCT_LIST_PARAM = "product";
export const HOME_MEDIA_PARAM = "media";

export interface HomeProductListRequest {
  /** `storefrontProductSourceKey(source)`. */
  key: string;
  source: StorefrontProductSource;
  limit: number;
}

export interface HomeSectionRequests {
  lists: HomeProductListRequest[];
  mediaIds: string[];
}

/** One key per source: `newest`, `on-sale`, `popular`, `collection:<id>`, `category:<id>`. */
export function storefrontProductSourceKey(source: StorefrontProductSource): string {
  if (source.kind === "collection") return `collection:${source.collectionId}`;
  if (source.kind === "category") return `category:${source.categoryId}`;
  return source.kind;
}

const ID_PATTERN = /^\S{1,64}$/;

export function parseStorefrontProductSourceKey(key: string): StorefrontProductSource | null {
  if (key === "newest" || key === "on-sale" || key === "popular") return { kind: key };
  const separator = key.indexOf(":");
  if (separator < 0) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!ID_PATTERN.test(id)) return null;
  if (kind === "collection") return { kind, collectionId: id };
  if (kind === "category") return { kind, categoryId: id };
  return null;
}

/** The product list a section shows, with how many products it needs. */
export function homeSectionProductList(section: StorefrontSection): { source: StorefrontProductSource; limit: number } | null {
  switch (section.type) {
    case "product-rail":
      return { source: section.settings.source, limit: section.settings.limit };
    case "product-grid":
      return { source: section.settings.source, limit: section.settings.columns * section.settings.rows };
    case "deal-block":
      return { source: section.settings.source, limit: HOME_DEAL_LIMIT };
    case "lookbook":
      return { source: section.settings.source, limit: HOME_LOOKBOOK_LIMIT };
    // Daraz "Just For You": the newest products, the listing continues them.
    case "endless-grid":
      return { source: { kind: "newest" }, limit: section.settings.pageSize };
    // A store without homepage collections shows its newest products instead.
    case "collections":
      return { source: { kind: "newest" }, limit: HOME_COLLECTIONS_FALLBACK_LIMIT };
    default:
      return null;
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
    default:
      return [];
  }
}

/**
 * Everything the sections read, in document order: one list per source
 * (the largest limit any section asks of it) and each image once, both
 * capped so a homepage costs the same bounded batch however it is built.
 */
export function homeSectionRequests(sections: readonly StorefrontSection[]): HomeSectionRequests {
  const lists = new Map<string, HomeProductListRequest>();
  const mediaIds = new Set<string>();
  for (const section of sections) {
    const list = homeSectionProductList(section);
    if (list) {
      const key = storefrontProductSourceKey(list.source);
      const limit = Math.min(list.limit, HOME_PRODUCT_LIST_LIMIT);
      const existing = lists.get(key);
      if (existing) existing.limit = Math.max(existing.limit, limit);
      else if (lists.size < HOME_MAX_PRODUCT_LISTS) lists.set(key, { key, source: list.source, limit });
    }
    for (const id of homeSectionMediaIds(section)) {
      if (mediaIds.size < HOME_MAX_MEDIA) mediaIds.add(id);
    }
  }
  return { lists: [...lists.values()], mediaIds: [...mediaIds] };
}

/** Query pairs for the homepage read: `product=<limit>~<key>`, `media=<id>`, sorted so equal requests share a cache key. */
export function homeSectionRequestParams(requests: HomeSectionRequests): Array<[string, string]> {
  return [
    ...requests.lists.map(({ key, limit }) => [HOME_PRODUCT_LIST_PARAM, `${limit}~${key}`] as [string, string]),
    ...requests.mediaIds.map((id) => [HOME_MEDIA_PARAM, id] as [string, string]),
  ].sort(([leftName, left], [rightName, right]) =>
    leftName === rightName ? (left < right ? -1 : left > right ? 1 : 0) : leftName < rightName ? -1 : 1);
}

/** The requests in a homepage query, or null when any value is malformed or over a cap. */
export function parseHomeSectionRequestParams(products: readonly string[], media: readonly string[]): HomeSectionRequests | null {
  if (products.length > HOME_MAX_PRODUCT_LISTS || media.length > HOME_MAX_MEDIA) return null;
  const lists = new Map<string, HomeProductListRequest>();
  for (const value of products) {
    const match = /^(\d{1,2})~(.+)$/.exec(value);
    const limit = match ? Number(match[1]) : 0;
    const source = match ? parseStorefrontProductSourceKey(match[2]!) : null;
    if (!source || limit < 1 || limit > HOME_PRODUCT_LIST_LIMIT) return null;
    const key = storefrontProductSourceKey(source);
    lists.set(key, { key, source, limit: Math.max(limit, lists.get(key)?.limit ?? 0) });
  }
  const mediaIds = new Set<string>();
  for (const id of media) {
    if (!ID_PATTERN.test(id)) return null;
    mediaIds.add(id);
  }
  return { lists: [...lists.values()], mediaIds: [...mediaIds] };
}
