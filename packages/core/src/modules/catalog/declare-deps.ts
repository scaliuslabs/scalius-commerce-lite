// Cache dependency declarations shared by the catalogue reads
// (audit/rewrite-2026-09-23/CACHE-DESIGN.md §6.5, keys in
// @scalius/shared/cache-deps). Every call is a no-op outside a dependency
// scope, so the reads behave the same with and without one. Not exported from
// the domain entry.
import { brandScope, categoryScope, type CacheDepScope } from "@scalius/shared/cache-deps";
import type { StorefrontProductFilterInput } from "../products/types";
import { deps } from "../../cache-deps";
import {
    productCardImageMediaIds,
    productGalleryMediaIds,
    type ProductMediaProjection,
} from "../products/media";

export { brandScope, categoryScope, deps };

/**
 * A product without a gallery depends on no media row: a file joins it only
 * through a new `product_media` row (its `p:` key). The media read still names
 * the `media` table, and coverage is decided per table and key kind, so the
 * read declares this `m:` key, which no row can advance (`~` is never in a
 * media id), instead of falling back to the whole table's key.
 */
const NO_MEDIA_ROW = "m:~";

/** One card: its product and the media rows its images come from. */
export function declareProductCard(productId: string, gallery: readonly ProductMediaProjection[] | undefined): void {
    if (!deps.active()) return;
    deps.product(productId);
    if (gallery && gallery.length > 0) deps.mediaItems(productCardImageMediaIds(gallery));
    else deps.key(NO_MEDIA_ROW);
}

/** Cards for these products, their images from `mediaByProductId`. */
export function declareProductCards(
    productIds: Iterable<string>,
    mediaByProductId: ReadonlyMap<string, readonly ProductMediaProjection[]>,
): void {
    if (!deps.active()) return;
    for (const id of productIds) declareProductCard(id, mediaByProductId.get(id));
}

const PRODUCT_ID_TOKEN = /^[\x21-\x7e]{1,200}$/;

/**
 * Product ids a buyer asked for (compare, lookups): each one's own changes,
 * including becoming public. A token no product id can equal (spaces,
 * non-ASCII, oversized) is skipped: it can never match a row.
 */
export function declareRequestedProducts(ids: Iterable<string>): void {
    if (!deps.active()) return;
    for (const id of ids) if (PRODUCT_ID_TOKEN.test(id)) deps.product(id);
}

/** A whole gallery shown (product page, feed rows with SKU images). */
export function declareProductGallery(productId: string, gallery: readonly ProductMediaProjection[] | undefined): void {
    if (!deps.active()) return;
    deps.product(productId);
    if (gallery && gallery.length > 0) deps.mediaItems(productGalleryMediaIds(gallery));
    else deps.key(NO_MEDIA_ROW);
}

/**
 * The set a listing reads and how it may change without a shown card
 * changing: registered scopes (`all`, a category subtree, a brand) whose
 * `lm:`/`lo:`/`lf:` keys the triggers advance, or a manual member list whose
 * own `p:` keys cover membership, order and prices.
 */
export interface ListingDependencySet {
    readonly scopes: readonly CacheDepScope[];
    /** Hand-picked member ids (a manual collection). */
    readonly members?: readonly string[];
}

/**
 * What a listing page depends on beyond its cards: the membership of its set
 * (and newest order), the price range every listing response carries, the
 * order and filters it applied, and its facet rows.
 */
export function declareListing(
    set: ListingDependencySet,
    params: Pick<StorefrontProductFilterInput, "sort" | "search" | "category" | "hasDiscount" | "freeDelivery" | "minPrice" | "maxPrice" | "attributeFilters">,
    options: { facets: boolean },
): void {
    if (!deps.active()) return;
    const sort = params.sort ?? (params.search ? "relevance" : "newest");
    const filteredByFacets = (params.attributeFilters?.length ?? 0) > 0;
    for (const scope of set.scopes) {
        deps.listMembership(scope);
        // priceRange is in every listing response.
        deps.listOrder("price", scope);
        if (sort === "discount" || params.hasDiscount === "true" || params.hasDiscount === "false") {
            deps.listOrder("disc", scope);
        }
        if (sort === "name-asc" || sort === "name-desc") deps.listOrder("name", scope);
        // Every listing counts the rating facet (and may sort by rating).
        deps.listOrder("rating", scope);
        if (options.facets || filteredByFacets) deps.listFacets(scope);
    }
    if (set.members) {
        deps.products(set.members);
        // Facet rows advance only `lf:` keys; a hand-picked set has no scope
        // of its own, so its facets depend on the whole public set's rows.
        if (options.facets || filteredByFacets) deps.listFacets("all");
    }
    if (params.search) {
        // Search text of products and categories, and the published state of
        // the categories a query can match by name or slug.
        deps.search();
        deps.anyCategory();
    }
    // `?category=` resolves an id or slug among published categories.
    if (params.category) deps.anyCategory();
    // The price filter tests every live SKU's price and availability, not
    // only the card SKU's stored range: any SKU change can move a product
    // across the bounds, so only the coarse SKU key is exact.
    if (params.minPrice !== undefined || params.maxPrice !== undefined) deps.table("product_variants");
    // Free delivery is a products column no listing key tracks.
    if (params.freeDelivery === "true" || params.freeDelivery === "false") deps.table("products");
}

/** Listing scopes for a set of category ids (a dynamic collection's rules). */
export function categoryScopes(categoryIds: Iterable<string>): CacheDepScope[] {
    return [...new Set(categoryIds)].map(categoryScope);
}

/** The brand scope of a brand page. */
export function brandScopes(brandId: string): CacheDepScope[] {
    return [brandScope(brandId)];
}
