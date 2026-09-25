/**
 * The declaration API readers call: `deps.product(id)`, `deps.settings(...)`.
 *
 * Each call adds a key to the dependency scope of the current async context
 * and is a cheap no-op outside one (admin reads, writes, queues, tests).
 * Declarations never change what a reader returns. Id-taking helpers skip
 * null/undefined so optional relations can be declared inline.
 *
 * Keys come from `cacheDep` in `@scalius/shared/cache-deps`, the registry the
 * database triggers are generated from; declaring one here means "my output
 * changes only when a trigger advances this key".
 */
import {
  CACHE_DEP_SOFT_MAX_AGE_SECONDS,
  cacheDep,
  type CacheDepListOrderFacet,
  type CacheDepScope,
} from "@scalius/shared/cache-deps";

import { activeDependencyScope } from "./scope";

type Id = string | null | undefined;

function declare(key: string): void {
  activeDependencyScope()?.declare(key);
}

function declareOne(build: (id: string) => string, id: Id): void {
  if (id === null || id === undefined || id === "") return;
  const scope = activeDependencyScope();
  if (scope !== null) scope.declare(build(id));
}

function declareEach(build: (id: string) => string, ids: Iterable<Id>): void {
  const scope = activeDependencyScope();
  if (scope === null) return;
  for (const id of ids) {
    if (id !== null && id !== undefined && id !== "") scope.declare(build(id));
  }
}

export const deps = {
  /** Whether a dependency scope is recording (skip building large id lists when not). */
  active: (): boolean => activeDependencyScope() !== null,

  /** A raw key from `cacheDep.*`; prefer the named helpers. */
  key: (key: string): void => declare(key),
  keys: (keys: Iterable<string>): void => {
    const scope = activeDependencyScope();
    if (scope === null) return;
    for (const key of keys) scope.declare(key);
  },

  // --- Catalogue ------------------------------------------------------------------
  /** `p:<id>`: every buyer-visible fact of one product (page, card, JSON-LD, feed row). */
  product: (productId: Id): void => declareOne(cacheDep.product, productId),
  /** `p:<id>` for every card, row or recommendation shown. */
  products: (productIds: Iterable<Id>): void => declareEach(cacheDep.product, productIds),
  /** `lm:<scope>`: which products are public members of a listing, and newest order. */
  listMembership: (scope: CacheDepScope): void => declare(cacheDep.listMembership(scope)),
  /** `lm:seo`: sitemap, product-feed and noindex flags of any product. */
  discoveryMembership: (): void => declare(cacheDep.discoveryMembership()),
  /** `lo:<facet>:<scope>`: a listing sorted or filtered by price, band, discount or name. */
  listOrder: (facet: CacheDepListOrderFacet, scope: CacheDepScope): void =>
    declare(cacheDep.listOrder(facet, scope)),
  /** `lf:<scope>`: facet values and counts of a listing. */
  listFacets: (scope: CacheDepScope): void => declare(cacheDep.listFacets(scope)),
  /** `srch`: searchable text of any product or category. */
  search: (): void => declare(cacheDep.search()),
  category: (categoryId: Id): void => declareOne(cacheDep.category, categoryId),
  categories: (categoryIds: Iterable<Id>): void => declareEach(cacheDep.category, categoryIds),
  anyCategory: (): void => declare(cacheDep.anyCategory()),
  brand: (brandId: Id): void => declareOne(cacheDep.brand, brandId),
  brands: (brandIds: Iterable<Id>): void => declareEach(cacheDep.brand, brandIds),
  anyBrand: (): void => declare(cacheDep.anyBrand()),
  collection: (collectionId: Id): void => declareOne(cacheDep.collection, collectionId),
  collections: (collectionIds: Iterable<Id>): void => declareEach(cacheDep.collection, collectionIds),
  anyCollection: (): void => declare(cacheDep.anyCollection()),
  attribute: (attributeId: Id): void => declareOne(cacheDep.attribute, attributeId),
  attributes: (attributeIds: Iterable<Id>): void => declareEach(cacheDep.attribute, attributeIds),
  anyAttribute: (): void => declare(cacheDep.anyAttribute()),
  media: (mediaId: Id): void => declareOne(cacheDep.media, mediaId),
  mediaItems: (mediaIds: Iterable<Id>): void => declareEach(cacheDep.media, mediaIds),
  /** `set:inventory:document`: required by every reader that shows an availability band. */
  inventoryBands: (): void => declare(cacheDep.settings("inventory", "document")),

  // --- Content, layout and settings ----------------------------------------------
  page: (pageId: Id): void => declareOne(cacheDep.page, pageId),
  pages: (pageIds: Iterable<Id>): void => declareEach(cacheDep.page, pageIds),
  anyPage: (): void => declare(cacheDep.anyPage()),
  /** `set:<category>:<key>`: one settings document row. */
  settings: (category: string, key: string): void => declare(cacheDep.settings(category, key)),
  theme: (): void => declare(cacheDep.theme()),
  navigation: (menuId: Id): void => declareOne(cacheDep.navigation, menuId),
  anyNavigation: (): void => declare(cacheDep.anyNavigation()),
  hero: (): void => declare(cacheDep.hero()),
  shipping: (): void => declare(cacheDep.shipping()),
  locations: (): void => declare(cacheDep.locations()),
  tax: (): void => declare(cacheDep.tax()),
  checkoutLanguages: (): void => declare(cacheDep.checkoutLanguages()),
  promotion: (promotionId: Id): void => declareOne(cacheDep.promotion, promotionId),
  promotions: (promotionIds: Iterable<Id>): void => declareEach(cacheDep.promotion, promotionIds),
  anyPromotion: (): void => declare(cacheDep.anyPromotion()),
  analytics: (): void => declare(cacheDep.analytics()),

  // --- Coarse, time and soft ------------------------------------------------------
  /** `t:<table>`: any change of the table. Correct but coarse; prefer a precise key. */
  table: (table: string): void => declare(cacheDep.table(table)),
  /**
   * The output's ordering comes from soft sources (recommendations, popularity)
   * the scope cannot observe as tables; it may lag by at most this many seconds.
   */
  softOrdering: (maxAgeSeconds: number = CACHE_DEP_SOFT_MAX_AGE_SECONDS): void => {
    activeDependencyScope()?.softMaxAge(maxAgeSeconds);
  },
  /**
   * A fact read switches at this instant (a promotion's start or end): the
   * entry is never served at or after it. Null/undefined/invalid are ignored.
   */
  validUntil: (at: Date | number | null | undefined): void => {
    if (at === null || at === undefined) return;
    const epochMs = at instanceof Date ? at.getTime() : at;
    activeDependencyScope()?.validUntil(epochMs);
  },
  /**
   * The output includes a fact no key can validate (a KV hint, a live provider
   * call, a per-buyer value): the entry must not be cached. Reason is a short
   * code, never a value.
   */
  uncacheable: (reason: string): void => {
    activeDependencyScope()?.uncacheable(reason);
  },
} as const;
