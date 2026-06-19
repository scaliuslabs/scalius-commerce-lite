// src/server/utils/cache-invalidation.ts
import type { Database } from "@scalius/database/client";
import { orderItems, products, productVariants } from "@scalius/database/schema";
import { normalizeStorefrontHtmlCachePaths } from "@scalius/shared/storefront-cache-path";
import { eq, inArray } from "drizzle-orm";
import { deleteCacheByPattern } from "./kv-cache";
import {
  API_CACHE_FENCE_GLOBAL_SCOPE,
  bumpApiCacheFence,
  bumpApiCacheFences,
  deleteVersionedCacheKeyFamily,
  getApiCacheFenceScopeForPattern,
} from "./api-cache-fence";

export const MAX_STOREFRONT_EXACT_HTML_PATHS = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InvalidationGroupDef {
  label: string;
  description: string;
  kvPrefixes: string[];
  bumpsHtml: boolean;
  storefrontPrefixes: string[];
}

export interface ProductAvailabilityCacheSubject {
  productId: string;
  slug: string | null;
}

export interface ProductAvailabilityCacheInput {
  orderIds?: readonly string[];
  productIds?: readonly string[];
  variantIds?: readonly string[];
}

export interface ProductAvailabilityCacheInvalidation {
  apiKeys: string[];
  apiPatterns: string[];
  storefrontPrefixes: string[];
  storefrontHtmlPaths: string[];
}

export function normalizeStorefrontHtmlPaths(
  paths: readonly string[],
  maxPaths = MAX_STOREFRONT_EXACT_HTML_PATHS,
): string[] {
  return normalizeStorefrontHtmlCachePaths(paths, maxPaths);
}

// ---------------------------------------------------------------------------
// Group definitions
// ---------------------------------------------------------------------------

export const INVALIDATION_GROUPS: Record<string, InvalidationGroupDef> = {
  products: {
    label: "Products",
    description:
      "Product listings, search results, and homepage product sections",
    kvPrefixes: ["api:products:", "api:search:", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: [
      "product_slug_",
      "product_variants_",
      "all_products_",
      "category_products_",
      "widgets_scope_",
      "storefront_homepage_",
    ],
  },
  categories: {
    label: "Categories",
    description: "Category pages, navigation menus, and search",
    kvPrefixes: [
      "api:categories:",
      "api:navigation:",
      "api:search:",
      "api:attributes:category",
      "api:storefront:homepage:",
    ],
    bumpsHtml: true,
    storefrontPrefixes: [
      "category_slug_",
      "global_all_categories",
      "category_products_",
      "filterable_attrs_category_",
      "widgets_scope_",
      "storefront_homepage_",
    ],
  },
  collections: {
    label: "Collections",
    description: "Collection pages and homepage collection sections",
    kvPrefixes: ["api:collections:", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: [
      "global_all_collections",
      "collection_by_id_",
      "widgets_scope_",
      "storefront_homepage_",
    ],
  },
  pages: {
    label: "Pages",
    description: "Static content pages",
    kvPrefixes: ["api:pages:", "api:storefront:page:"],
    bumpsHtml: true,
    storefrontPrefixes: ["page_slug_", "page_render_", "all_pages_"],
  },
  layout: {
    label: "Layout",
    description:
      "Header, footer, navigation, analytics, and site-wide settings",
    kvPrefixes: [
      "api:header:",
      "api:footer:",
      "api:navigation:",
      "api:analytics:",
      "api:storefront:layout:",
      "api:storefront:csp:",
    ],
    bumpsHtml: true,
    storefrontPrefixes: [
      "storefront_layout_",
      "global_header_data",
      "global_footer_data",
      "global_navigation_",
      "global_analytics_config",
      "global_security_settings",
    ],
  },
  media: {
    label: "Media",
    description: "CDN host policy and image optimization settings",
    kvPrefixes: ["api:storefront:layout:", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: ["storefront_layout_", "storefront_homepage_"],
  },
  homepage: {
    label: "Homepage",
    description: "Hero sliders, widgets, SEO settings",
    kvPrefixes: [
      "api:hero:",
      "api:widgets:active-homepage:",
      "api:widgets:single:",
      "api:seo:",
      "api:storefront:homepage:",
    ],
    bumpsHtml: true,
    storefrontPrefixes: [
      "homepage_hero_sliders",
      "global_homepage_widgets",
      "widget_",
      "global_seo_settings",
      "storefront_homepage_",
    ],
  },
  widgets: {
    label: "Widgets",
    description:
      "Widget content, homepage widgets, scoped widget placements, and shortcode rendering",
    kvPrefixes: [
      "api:widgets:single:",
      "api:widgets:active-homepage:",
      "api:storefront:homepage:",
      "api:storefront:page:",
    ],
    bumpsHtml: true,
    storefrontPrefixes: [
      "widget_",
      "global_homepage_widgets",
      "widgets_scope_",
      "storefront_homepage_",
      "page_render_",
    ],
  },
  checkout: {
    label: "Checkout",
    description: "Shipping methods, delivery locations, payment settings",
    kvPrefixes: [
      "api:checkout:config:",
      "api:checkout:config:v2:",
      "api:shipping-methods:",
      "api:locations:",
    ],
    bumpsHtml: false,
    storefrontPrefixes: [
      "global_shipping_cities",
      "shipping_zones_",
      "shipping_areas_",
      "global_shipping_methods",
      "checkout_config",
      "global_checkout_language",
    ],
  },
  search: {
    label: "Search",
    description: "Search index and filtering",
    kvPrefixes: ["api:search:", "api:attributes:search-filters"],
    bumpsHtml: true,
    storefrontPrefixes: ["all_products_", "filterable_attrs_"],
  },
  attributes: {
    label: "Attributes",
    description: "Product attributes and filterable attributes",
    kvPrefixes: [
      "api:attributes:filterable",
      "api:attributes:category",
      "api:attributes:category-slug",
      "api:attributes:search-filters",
    ],
    bumpsHtml: true,
    storefrontPrefixes: ["filterable_attrs_"],
  },
};

// ---------------------------------------------------------------------------
// Admin path → group mapping
// ---------------------------------------------------------------------------

export const CATALOG_CACHE_GROUPS = {
  products: ["products", "search", "collections", "attributes"],
  categories: ["categories", "products", "search", "collections", "layout"],
  collections: ["collections"],
  discounts: ["products", "search", "collections"],
} as const;

export type CatalogCacheDomain = keyof typeof CATALOG_CACHE_GROUPS;

export const WIDGET_CACHE_GROUPS = [
  "widgets",
] as const;

export const ADMIN_PATH_TO_GROUPS: Record<string, string[]> = {
  "/api/v1/admin/products": [...CATALOG_CACHE_GROUPS.products],
  "/api/v1/admin/categories": [...CATALOG_CACHE_GROUPS.categories],
  "/api/v1/admin/collections": [...CATALOG_CACHE_GROUPS.collections],
  "/api/v1/admin/pages": ["pages", "layout"],
  "/api/v1/admin/widgets": [...WIDGET_CACHE_GROUPS],
  "/api/v1/admin/navigation": ["layout"],
  "/api/v1/admin/analytics": ["layout"],
  "/api/v1/admin/settings/header": ["layout"],
  "/api/v1/admin/settings/footer": ["layout"],
  "/api/v1/admin/settings/storefront-url": ["layout"],
  "/api/v1/admin/settings/hero-sliders": ["homepage"],
  "/api/v1/admin/settings/seo": ["homepage"],
  "/api/v1/admin/settings/security": ["layout"],
  "/api/v1/admin/settings/theme": ["layout"],
  "/api/v1/admin/settings/media": ["media"],
  "/api/v1/admin/settings/currency": ["layout", "checkout"],
  "/api/v1/admin/settings/auth": ["checkout"],
  "/api/v1/admin/settings/allowed-countries": ["checkout"],
  "/api/v1/admin/settings/delivery-locations": ["checkout"],
  "/api/v1/admin/settings/delivery-providers": ["checkout"],
  "/api/v1/admin/settings/payment-methods": ["checkout"],
  "/api/v1/admin/settings/stripe": ["checkout"],
  "/api/v1/admin/settings/sslcommerz": ["checkout"],
  "/api/v1/admin/settings/polar": ["checkout"],
  "/api/v1/admin/settings/shipping-methods": ["checkout"],
  "/api/v1/admin/settings/checkout-languages": ["checkout"],
  "/api/v1/admin/settings/meta-conversions": ["layout"],
  "/api/v1/admin/attributes": ["attributes", "products"],
  "/api/v1/admin/discounts": [...CATALOG_CACHE_GROUPS.discounts],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine which invalidation groups a given admin path belongs to.
 */
export function getGroupsForPath(pathname: string): string[] {
  for (const [path, groups] of Object.entries(ADMIN_PATH_TO_GROUPS)) {
    if (pathname.startsWith(path)) {
      return groups;
    }
  }
  return [];
}

/**
 * Returns true if any of the given groups has `bumpsHtml` set.
 */
export function shouldBumpStorefrontVersion(groups: string[]): boolean {
  return groups.some((g) => INVALIDATION_GROUPS[g]?.bumpsHtml === true);
}

/**
 * Collect unique storefront prefixes from all given groups.
 */
export function getStorefrontPrefixesForGroups(groups: string[]): string[] {
  const prefixes = new Set<string>();
  for (const g of groups) {
    const def = INVALIDATION_GROUPS[g];
    if (def) {
      for (const p of def.storefrontPrefixes) {
        prefixes.add(p);
      }
    }
  }
  return [...prefixes];
}

export interface StorefrontPurgeResult {
  attempted: boolean;
  ok: boolean;
  status?: number;
  skippedReason?: "no-valid-groups" | "no-prefixes" | "missing-config";
}

function storefrontPurgeHeaders(purgeToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${purgeToken}`,
    "Content-Type": "application/json",
  };
}

export function normalizeStorefrontPurgeUrl(purgeUrl: string): string {
  const url = new URL(purgeUrl);
  // Legacy deployments sometimes carried the purge token in PURGE_URL. Strip
  // known credential params so callers never send purge secrets in URLs.
  for (const key of ["token", "purgeToken", "purge_token", "access_token"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

/**
 * Execute the storefront purge request and report whether it succeeded.
 * Content writes that immediately affect rendered pages can await this helper
 * so the next storefront request sees the bumped HTML/cache version.
 */
export async function purgeStorefrontForGroups(
  groups: string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
): Promise<StorefrontPurgeResult> {
  const validGroups = groups.filter((g) => g in INVALIDATION_GROUPS);
  if (validGroups.length === 0) {
    return { attempted: false, ok: false, skippedReason: "no-valid-groups" };
  }

  const purgeUrl = env?.PURGE_URL;
  const purgeToken = env?.PURGE_TOKEN;
  if (!purgeUrl || !purgeToken) {
    return { attempted: false, ok: false, skippedReason: "missing-config" };
  }

  const response = await fetch(normalizeStorefrontPurgeUrl(purgeUrl), {
    method: "POST",
    headers: storefrontPurgeHeaders(purgeToken),
    body: JSON.stringify({
      groups: validGroups,
      prefixes: getStorefrontPrefixesForGroups(validGroups),
      bumpVersion: shouldBumpStorefrontVersion(validGroups),
    }),
  });

  if (!response.ok) {
    console.error("[Cache] Storefront group purge failed:", {
      status: response.status,
      groups: validGroups,
    });
  }

  return { attempted: true, ok: response.ok, status: response.status };
}

/**
 * Execute a storefront purge for already-computed logical cache prefixes.
 * This is used by writes such as widgets where the affected storefront keys
 * can be narrower than a whole invalidation group.
 */
export async function purgeStorefrontForPrefixes(
  prefixes: readonly string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
  options: {
    groups?: readonly string[];
    bumpVersion?: boolean;
    exactKeys?: readonly string[];
    htmlPaths?: readonly string[];
  } = {},
): Promise<StorefrontPurgeResult> {
  const uniquePrefixes = [...new Set(prefixes.filter(Boolean))];
  const uniqueExactKeys = [...new Set((options.exactKeys ?? []).filter(Boolean))];
  const uniqueHtmlPaths = normalizeStorefrontHtmlPaths(options.htmlPaths ?? []);
  if (
    uniquePrefixes.length === 0 &&
    uniqueExactKeys.length === 0 &&
    uniqueHtmlPaths.length === 0 &&
    options.bumpVersion !== true
  ) {
    return { attempted: false, ok: false, skippedReason: "no-prefixes" };
  }

  const purgeUrl = env?.PURGE_URL;
  const purgeToken = env?.PURGE_TOKEN;
  if (!purgeUrl || !purgeToken) {
    return { attempted: false, ok: false, skippedReason: "missing-config" };
  }

  const body: {
    groups: string[];
    prefixes: string[];
    exactKeys?: string[];
    htmlPaths?: string[];
    bumpVersion: boolean;
  } = {
    groups: [...new Set(options.groups ?? [])],
    prefixes: uniquePrefixes,
    bumpVersion: options.bumpVersion === true,
  };
  if (uniqueExactKeys.length > 0) {
    body.exactKeys = uniqueExactKeys;
  }
  if (uniqueHtmlPaths.length > 0) {
    body.htmlPaths = uniqueHtmlPaths;
  }

  const response = await fetch(normalizeStorefrontPurgeUrl(purgeUrl), {
    method: "POST",
    headers: storefrontPurgeHeaders(purgeToken),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("[Cache] Storefront prefix purge failed:", {
      status: response.status,
      groups: options.groups,
      prefixes: uniquePrefixes,
    });
  }

  return { attempted: true, ok: response.ok, status: response.status };
}

/**
 * Trigger the storefront purge endpoint for the given invalidation groups.
 *
 * This bumps the storefront HTML cache version when any group requires it and
 * clears matching in-memory prefixes on the worker that receives the purge.
 * The request is intentionally fire-and-forget via waitUntil so admin writes
 * are not blocked by a downstream storefront network hop.
 */
export function triggerStorefrontPurgeForGroups(
  groups: string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
  executionCtx?: ExecutionContext,
): void {
  const validGroups = groups.filter((g) => g in INVALIDATION_GROUPS);
  if (validGroups.length === 0) return;

  const purgeUrl = env?.PURGE_URL;
  const purgeToken = env?.PURGE_TOKEN;
  if (!purgeUrl || !purgeToken) return;

  const purgePromise = purgeStorefrontForGroups(validGroups, env).catch((err) =>
    console.error("[Cache] Storefront group purge failed:", err),
  );

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(purgePromise);
  } else {
    void purgePromise;
  }
}

/**
 * Trigger the storefront purge endpoint for exact storefront cache prefixes.
 * This is the scheduled counterpart to `purgeStorefrontForPrefixes()` for
 * committed writes whose purge should not decide whether the mutation succeeded.
 */
export function triggerStorefrontPurgeForPrefixes(
  prefixes: readonly string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
  options: {
    groups?: readonly string[];
    bumpVersion?: boolean;
    exactKeys?: readonly string[];
    htmlPaths?: readonly string[];
  } = {},
  executionCtx?: ExecutionContext,
): void {
  const uniquePrefixes = [...new Set(prefixes.filter(Boolean))];
  const uniqueExactKeys = [...new Set((options.exactKeys ?? []).filter(Boolean))];
  const uniqueHtmlPaths = normalizeStorefrontHtmlPaths(options.htmlPaths ?? []);
  if (
    uniquePrefixes.length === 0 &&
    uniqueExactKeys.length === 0 &&
    uniqueHtmlPaths.length === 0 &&
    options.bumpVersion !== true
  ) {
    return;
  }

  const purgeUrl = env?.PURGE_URL;
  const purgeToken = env?.PURGE_TOKEN;
  if (!purgeUrl || !purgeToken) return;

  const purgePromise = purgeStorefrontForPrefixes(
    uniquePrefixes,
    env,
    { ...options, exactKeys: uniqueExactKeys, htmlPaths: uniqueHtmlPaths },
  ).catch((err) =>
    console.error("[Cache] Storefront prefix purge failed:", err),
  );

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(purgePromise);
  } else {
    void purgePromise;
  }
}

export function getOptionalExecutionContext(c: {
  executionCtx?: ExecutionContext;
}): ExecutionContext | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * Invalidate API KV entries and schedule the matching storefront purge.
 * Use this after admin writes that have already committed DB/KV state, so a
 * downstream storefront network/purge failure cannot turn the mutation into a
 * false 500 response.
 */
export async function invalidateApiAndScheduleStorefrontGroups(
  groups: readonly string[],
  c: { env?: Env; executionCtx?: ExecutionContext },
): Promise<void> {
  const normalizedGroups = [...groups];
  await invalidateGroups(normalizedGroups, c.env?.CACHE);
  triggerStorefrontPurgeForGroups(
    normalizedGroups,
    c.env,
    getOptionalExecutionContext(c),
  );
}

/**
 * Invalidate API KV entries and await the matching storefront purge.
 * Use this after admin writes whose response should not claim success until the
 * storefront cache version/prefix purge has been attempted.
 */
export async function invalidateApiAndStorefrontGroups(
  groups: readonly string[],
  env?: Env,
): Promise<void> {
  const normalizedGroups = [...groups];
  await invalidateGroups(normalizedGroups, env?.CACHE);
  await purgeStorefrontForGroups(normalizedGroups, env);
}

/**
 * Invalidate KV cache entries for the given groups.
 * Collects all unique KV prefixes and calls deleteCacheByPattern for each.
 */
export async function invalidateGroups(
  groups: string[],
  kv?: KVNamespace,
): Promise<void> {
  const prefixes = new Set<string>();
  for (const g of groups) {
    const def = INVALIDATION_GROUPS[g];
    if (def) {
      for (const p of def.kvPrefixes) {
        prefixes.add(p);
      }
    }
  }

  const uniquePrefixes = [...prefixes];
  if (uniquePrefixes.length === 0) return;

  console.log(
    `[Cache] Invalidating groups [${groups.join(", ")}] – ${uniquePrefixes.length} KV prefix(es)`,
  );

  await bumpApiCacheFences(uniquePrefixes, kv);

  await Promise.all(
    uniquePrefixes.map((prefix) => deleteCacheByPattern(`${prefix}*`, kv)),
  );
}

/**
 * Invalidate exact API KV key patterns that were computed outside the coarse
 * group map.
 */
export async function invalidateApiCachePatterns(
  patterns: readonly string[],
  kv?: KVNamespace,
): Promise<void> {
  const uniquePatterns = [...new Set(patterns.filter(Boolean))];
  if (uniquePatterns.length === 0) return;

  console.log(
    `[Cache] Invalidating ${uniquePatterns.length} targeted API KV pattern(s)`,
  );

  await bumpApiCacheFences(
    uniquePatterns
      .map(getApiCacheFenceScopeForPattern)
      .filter((scope): scope is string => Boolean(scope)),
    kv,
  );

  await Promise.all(
    uniquePatterns.map((pattern) => deleteCacheByPattern(pattern, kv)),
  );
}

function uniqueValues(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).filter(Boolean))];
}

function uniqueAvailabilitySubjects(
  subjects: readonly ProductAvailabilityCacheSubject[],
): ProductAvailabilityCacheSubject[] {
  const byProduct = new Map<string, ProductAvailabilityCacheSubject>();
  for (const subject of subjects) {
    if (!subject.productId) continue;
    byProduct.set(subject.productId, subject);
  }
  return [...byProduct.values()];
}

/**
 * Resolve product detail cache subjects from stock-changing entities.
 * Order items can survive soft deletes, but permanent deletes remove them, so
 * callers for destructive order writes should resolve before the DB mutation
 * and then invalidate the returned subjects after the mutation commits.
 */
export async function resolveProductAvailabilityCacheSubjects(
  db: Database,
  input: ProductAvailabilityCacheInput,
): Promise<ProductAvailabilityCacheSubject[]> {
  const orderIds = uniqueValues(input.orderIds);
  const productIds = uniqueValues(input.productIds);
  const variantIds = uniqueValues(input.variantIds);
  const subjectRows: ProductAvailabilityCacheSubject[] = [];

  if (orderIds.length > 0) {
    const rows = await db
      .selectDistinct({
        productId: products.id,
        slug: products.slug,
      })
      .from(orderItems)
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIds));
    subjectRows.push(...rows);
  }

  if (productIds.length > 0) {
    const rows = await db
      .selectDistinct({
        productId: products.id,
        slug: products.slug,
      })
      .from(products)
      .where(inArray(products.id, productIds));
    subjectRows.push(...rows);
  }

  if (variantIds.length > 0) {
    const rows = await db
      .selectDistinct({
        productId: products.id,
        slug: products.slug,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    subjectRows.push(...rows);
  }

  return uniqueAvailabilitySubjects(subjectRows);
}

export async function tryResolveProductAvailabilityCacheSubjects(
  db: Database,
  input: ProductAvailabilityCacheInput,
): Promise<ProductAvailabilityCacheSubject[]> {
  try {
    return await resolveProductAvailabilityCacheSubjects(db, input);
  } catch (error) {
    console.error(
      "[Cache] Failed to resolve product availability cache subjects:",
      error,
    );
    return [];
  }
}

export function getProductAvailabilityApiCacheKeys(
  subjects: readonly ProductAvailabilityCacheSubject[],
): string[] {
  const normalizedSubjects = uniqueAvailabilitySubjects(subjects);
  if (normalizedSubjects.length === 0) return [];

  return [
    ...normalizedSubjects
      .filter((subject): subject is ProductAvailabilityCacheSubject & { slug: string } =>
        typeof subject.slug === "string" && subject.slug.length > 0,
      )
      .map((subject) => `api:products:/api/v1/products/${subject.slug}`),
    "api:products:/api/v1/products/search",
  ];
}

export function getProductAvailabilityApiCachePatterns(
  subjects: readonly ProductAvailabilityCacheSubject[],
): string[] {
  const normalizedSubjects = uniqueAvailabilitySubjects(subjects);
  if (normalizedSubjects.length === 0) return [];

  return [
    ...normalizedSubjects
      .filter((subject): subject is ProductAvailabilityCacheSubject & { slug: string } =>
        typeof subject.slug === "string" && subject.slug.length > 0,
      )
      .map((subject) => `api:products:/api/v1/products/${subject.slug}?*`),
    "api:products:/api/v1/products/search?*",
    "api:search:*",
  ];
}

export function getProductAvailabilityStorefrontPrefixes(
  subjects: readonly ProductAvailabilityCacheSubject[],
): string[] {
  return uniqueAvailabilitySubjects(subjects).flatMap((subject) => [
    ...(subject.slug ? [`product_slug_${subject.slug}`] : []),
    `product_variants_${subject.productId}`,
  ]);
}

export function collectProductAvailabilityCacheInvalidation(
  subjects: readonly ProductAvailabilityCacheSubject[],
): ProductAvailabilityCacheInvalidation {
  const normalizedSubjects = uniqueAvailabilitySubjects(subjects);
  return {
    apiKeys: getProductAvailabilityApiCacheKeys(normalizedSubjects),
    apiPatterns: getProductAvailabilityApiCachePatterns(normalizedSubjects),
    storefrontPrefixes: getProductAvailabilityStorefrontPrefixes(normalizedSubjects),
    storefrontHtmlPaths: normalizedSubjects
      .filter((subject): subject is ProductAvailabilityCacheSubject & { slug: string } =>
        typeof subject.slug === "string" && subject.slug.length > 0,
      )
      .map((subject) => `/products/${subject.slug}`),
  };
}

export async function invalidateProductAvailabilityCacheSubjects(
  subjects: readonly ProductAvailabilityCacheSubject[],
  c: { env?: Env; executionCtx?: ExecutionContext },
): Promise<void> {
  const normalizedSubjects = uniqueAvailabilitySubjects(subjects);
  if (normalizedSubjects.length === 0) return;

  const invalidation = collectProductAvailabilityCacheInvalidation(normalizedSubjects);

  console.log(
    `[Cache] Invalidating product availability for ${normalizedSubjects.length} product(s)`,
  );

  await bumpApiCacheFences(
    [
      ...invalidation.apiKeys,
      ...invalidation.apiPatterns
        .map(getApiCacheFenceScopeForPattern)
        .filter((scope): scope is string => Boolean(scope)),
    ],
    c.env?.CACHE,
  );

  await Promise.all([
    ...invalidation.apiKeys.map((key) =>
      deleteVersionedCacheKeyFamily(key, c.env?.CACHE),
    ),
    ...invalidation.apiPatterns.map((pattern) =>
      deleteCacheByPattern(pattern, c.env?.CACHE),
    ),
  ]);

  triggerStorefrontPurgeForPrefixes(
    [],
    c.env,
    {
      groups: ["products"],
      bumpVersion: false,
      exactKeys: invalidation.storefrontPrefixes,
      htmlPaths: invalidation.storefrontHtmlPaths,
    },
    getOptionalExecutionContext(c),
  );
}

/**
 * Invalidate product detail/search API KV and exact storefront product cache
 * prefixes for stock-changing writes such as order creation, cancellation,
 * refund, return, shipment, and admin stock edits.
 */
export async function invalidateProductAvailabilityCaches(
  db: Database,
  input: ProductAvailabilityCacheInput,
  c: { env?: Env; executionCtx?: ExecutionContext },
): Promise<void> {
  const subjects = await tryResolveProductAvailabilityCacheSubjects(db, input);
  await invalidateProductAvailabilityCacheSubjects(subjects, c);
}

/**
 * Invalidate the API KV cache and schedule the storefront purge needed after a
 * catalog write. Product and discount changes also clear collection caches
 * because collection pages render product cards, images, and prices.
 */
export async function invalidateCatalogCaches(
  domain: CatalogCacheDomain,
  c: { env?: Env; executionCtx?: ExecutionContext },
): Promise<void> {
  const groups = [...CATALOG_CACHE_GROUPS[domain]];
  await invalidateGroups(groups, c.env?.CACHE);
  triggerStorefrontPurgeForGroups(groups, c.env, getOptionalExecutionContext(c));
}

/**
 * Clear the entire API cache (all keys under the project prefix).
 */
export async function invalidateEntireCache(kv?: KVNamespace): Promise<void> {
  try {
    await bumpApiCacheFence(API_CACHE_FENCE_GLOBAL_SCOPE, kv);
    await deleteCacheByPattern("api:*", kv);
    console.log("[Cache] Successfully cleared the entire project cache.");
  } catch (error: unknown) {
    console.error("[Cache] Error clearing the entire project cache:", error);
  }
}
