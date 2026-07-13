// src/server/utils/cache-invalidation.ts
import type { Database } from "@scalius/database/client";
import {
  collections,
  orderItems,
  pages,
  products,
  productVariants,
} from "@scalius/database/schema";
import { publicPageVisibilityCondition } from "@scalius/core/modules/pages";
import { parseShortcodes } from "@scalius/shared/shortcodes";
import { normalizeStorefrontHtmlCachePaths } from "@scalius/shared/storefront-cache-path";
import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { deleteCacheByPattern } from "./kv-cache";
import {
  API_CACHE_FENCE_GLOBAL_SCOPE,
  bumpApiCacheFence,
  bumpApiCacheFences,
  deleteVersionedCacheKeyFamily,
  getApiCacheFenceScopeForPattern,
} from "./api-cache-fence";
import {
  PRODUCT_API_CACHE_NAMESPACE,
  getProductApiCacheKey,
  getProductApiQueryCachePattern,
} from "./product-api-cache";

export const MAX_STOREFRONT_EXACT_HTML_PATHS = 20;
export const D1_CACHE_SUBJECT_ID_CHUNK_SIZE = 90;
const STOREFRONT_WARM_PATH_BATCH_SIZE = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

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
  categoryId?: string | null;
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

export interface CollectionCacheDependencyInput {
  productIds?: readonly string[];
  categoryIds?: readonly string[];
}

export interface CollectionCacheTarget {
  id: string;
}

export interface CollectionCacheInvalidation {
  apiKeys: string[];
  apiPatterns: string[];
  storefrontPrefixes: string[];
  storefrontHtmlPaths: string[];
}

export interface CmsShortcodePageTarget {
  id: string;
  slug: string;
}

export interface CmsShortcodeReferenceInput {
  productSlugs?: readonly string[];
}

export interface CmsShortcodePageInvalidation {
  apiPatterns: string[];
  storefrontPrefixes: string[];
  storefrontHtmlPaths: string[];
  bumpVersion: boolean;
}

export interface StorefrontCachePurgeQueueMessage {
  type: "storefront.cache_purge";
  operationId: string;
  groups: string[];
  prefixes: string[];
  exactKeys?: string[];
  htmlPaths?: string[];
  bumpVersion: boolean;
  source: string;
  requestedAt: number;
}

export interface StorefrontCacheWarmQueueMessage {
  type: "storefront.cache_warm";
  operationId: string;
  paths: string[];
  source: string;
  requestedAt: number;
}

export type StorefrontCacheQueueMessage =
  | StorefrontCachePurgeQueueMessage
  | StorefrontCacheWarmQueueMessage;

type StorefrontCacheQueue = Pick<Queue<StorefrontCacheQueueMessage>, "send">;
type StorefrontPurgeEnv = Pick<Env, "PURGE_URL" | "PURGE_TOKEN"> & {
  STOREFRONT_CACHE_QUEUE?: StorefrontCacheQueue;
};

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
    kvPrefixes: [
      PRODUCT_API_CACHE_NAMESPACE,
      "api:categories:",
      "api:search:",
      "api:storefront:homepage:",
    ],
    bumpsHtml: true,
    storefrontPrefixes: [
      "product_slug_",
      "product_variants_",
      "all_products_",
      "category_products_",
      "feed_products_",
      "sitemap_products_",
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
    description: "Hero sliders and SEO settings",
    kvPrefixes: [
      "api:hero:",
      "api:seo:",
      "api:storefront:homepage:",
    ],
    bumpsHtml: true,
    storefrontPrefixes: [
      "homepage_hero_sliders",
      "global_seo_settings",
      "storefront_homepage_",
    ],
  },
  discovery: {
    label: "Discovery",
    description: "SEO policy, robots, sitemap XML, and product feed XML",
    kvPrefixes: ["api:seo:"],
    bumpsHtml: true,
    storefrontPrefixes: [
      "global_seo_settings",
      "feed_products_",
      "sitemap_products_",
    ],
  },
  checkout: {
    label: "Checkout",
    description: "Shipping methods, delivery locations, payment settings",
    kvPrefixes: [
      "api:checkout:config:",
      "api:checkout:config:v2:",
      "api:checkout:config:v3:",
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
  "product-schema": {
    label: "Product schema",
    description:
      "Product-page commerce facts sourced outside the product aggregate",
    kvPrefixes: [],
    bumpsHtml: true,
    storefrontPrefixes: ["product_slug_"],
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
  products: ["products", "search", "collections", "attributes", "layout"],
  categories: ["categories", "products", "search", "collections", "layout"],
  collections: ["collections", "layout"],
  discounts: ["products", "search", "collections"],
} as const;

export type CatalogCacheDomain = keyof typeof CATALOG_CACHE_GROUPS;

export type SettingsCacheStrategy =
  | "shared-projection"
  | "authoritative-read"
  | "credential-scoped"
  | "cache-operation";

export interface SettingsCacheDependencyDef {
  path: string;
  groups: readonly string[];
  strategy: SettingsCacheStrategy;
  note: string;
}

/** Every merchant-settings mutation surface and its shared-cache policy. */
export const SETTINGS_CACHE_DEPENDENCIES = {
  currency: { path: "/api/v1/admin/settings/currency", groups: ["layout", "checkout"], strategy: "shared-projection", note: "Layout currency and checkout totals." },
  header: { path: "/api/v1/admin/settings/header", groups: ["layout"], strategy: "shared-projection", note: "Global storefront header." },
  footer: { path: "/api/v1/admin/settings/footer", groups: ["layout"], strategy: "shared-projection", note: "Global storefront footer." },
  navigation: { path: "/api/v1/admin/navigation", groups: ["layout"], strategy: "shared-projection", note: "Header and footer menu trees." },
  business: { path: "/api/v1/admin/settings/business", groups: ["layout"], strategy: "shared-projection", note: "Public business and schema identity." },
  theme: { path: "/api/v1/admin/settings/theme", groups: ["layout"], strategy: "shared-projection", note: "Global storefront presentation." },
  media: { path: "/api/v1/admin/settings/media", groups: ["media"], strategy: "shared-projection", note: "Layout/homepage image policy." },
  seo: { path: "/api/v1/admin/settings/seo", groups: ["homepage", "layout", "discovery"], strategy: "shared-projection", note: "Metadata, discovery and schema." },
  storefrontUrl: { path: "/api/v1/admin/settings/storefront-url", groups: ["homepage", "layout", "discovery"], strategy: "shared-projection", note: "Discovery origins plus gw:storefront_url." },
  heroSliders: { path: "/api/v1/admin/settings/hero-sliders", groups: ["homepage"], strategy: "shared-projection", note: "Homepage hero." },
  analytics: { path: "/api/v1/admin/analytics", groups: ["layout"], strategy: "shared-projection", note: "Browser analytics injection." },
  metaConversions: { path: "/api/v1/admin/settings/meta-conversions", groups: ["layout"], strategy: "shared-projection", note: "Browser readiness; dispatch reads D1." },
  security: { path: "/api/v1/admin/settings/security", groups: ["layout"], strategy: "shared-projection", note: "CSP projections and Partytown write-through." },
  allowedCountries: { path: "/api/v1/admin/settings/allowed-countries", groups: ["checkout"], strategy: "shared-projection", note: "Checkout phone-country policy." },
  checkoutFlow: { path: "/api/v1/admin/settings/checkout-flow", groups: ["checkout"], strategy: "shared-projection", note: "Buyer checkout flow." },
  customerAuth: { path: "/api/v1/admin/settings/auth", groups: ["checkout"], strategy: "shared-projection", note: "Customer sign-in readiness." },
  email: { path: "/api/v1/admin/settings/email", groups: ["checkout"], strategy: "shared-projection", note: "Sign-in readiness; dispatch reads D1." },
  sms: { path: "/api/v1/admin/settings/sms", groups: ["checkout"], strategy: "shared-projection", note: "Sign-in readiness; dispatch reads D1." },
  firebase: { path: "/api/v1/admin/settings/firebase", groups: [], strategy: "credential-scoped", note: "D1 settings; OAuth KV key includes credential fingerprint." },
  notificationChannels: { path: "/api/v1/admin/settings/notification-channels", groups: [], strategy: "authoritative-read", note: "Dispatch resolves D1 policy." },
  paymentMethods: { path: "/api/v1/admin/settings/payment-methods", groups: ["checkout"], strategy: "shared-projection", note: "Buyer payment allowlist." },
  stripe: { path: "/api/v1/admin/settings/stripe", groups: ["checkout"], strategy: "shared-projection", note: "Checkout plus provider cache." },
  sslcommerz: { path: "/api/v1/admin/settings/sslcommerz", groups: ["checkout"], strategy: "shared-projection", note: "Checkout plus provider cache." },
  polar: { path: "/api/v1/admin/settings/polar", groups: ["checkout"], strategy: "shared-projection", note: "Checkout plus provider cache." },
  shippingMethods: { path: "/api/v1/admin/settings/shipping-methods", groups: ["checkout", "product-schema"], strategy: "shared-projection", note: "Checkout and Product shippingDetails." },
  deliveryLocations: { path: "/api/v1/admin/settings/delivery-locations", groups: ["checkout"], strategy: "shared-projection", note: "Checkout location hierarchy." },
  deliveryProviders: { path: "/api/v1/admin/settings/delivery-providers", groups: ["checkout"], strategy: "shared-projection", note: "Delivery readiness; fulfillment reads D1." },
  checkoutLanguages: { path: "/api/v1/admin/settings/checkout-languages", groups: ["checkout"], strategy: "shared-projection", note: "Checkout labels and fields." },
  tax: { path: "/api/v1/admin/taxes", groups: ["checkout"], strategy: "shared-projection", note: "Checkout/order tax authority." },
  customerRequests: { path: "/api/v1/admin/settings/customer-requests", groups: [], strategy: "authoritative-read", note: "Private eligibility reads D1." },
  fraud: { path: "/api/v1/admin/fraud-checker", groups: [], strategy: "authoritative-read", note: "Risk lookup reads D1." },
  cacheOperations: { path: "/api/v1/cache", groups: [], strategy: "cache-operation", note: "Purges/replays mutate cache state, not merchant facts." },
} as const satisfies Record<string, SettingsCacheDependencyDef>;

export interface CatalogCacheInvalidationOptions {
  htmlPaths?: readonly string[];
}

const CATALOG_DEFAULT_HTML_PATHS: Record<CatalogCacheDomain, readonly string[]> = {
  products: ["/search"],
  categories: ["/search"],
  collections: [],
  discounts: ["/search"],
};

export function getCatalogStorefrontHtmlPaths(
  domain: CatalogCacheDomain,
  paths: readonly string[] = [],
): string[] {
  return normalizeStorefrontHtmlPaths([
    ...CATALOG_DEFAULT_HTML_PATHS[domain],
    ...paths,
  ]);
}

export const ADMIN_PATH_TO_GROUPS: Record<string, string[]> = {
  "/api/v1/admin/products": [...CATALOG_CACHE_GROUPS.products],
  "/api/v1/admin/categories": [...CATALOG_CACHE_GROUPS.categories],
  "/api/v1/admin/collections": [...CATALOG_CACHE_GROUPS.collections],
  "/api/v1/admin/pages": ["pages", "layout"],
  "/api/v1/admin/navigation": ["layout"],
  "/api/v1/admin/analytics": ["layout"],
  "/api/v1/admin/settings/header": ["layout"],
  "/api/v1/admin/settings/footer": ["layout"],
  "/api/v1/admin/settings/business": ["layout"],
  "/api/v1/admin/settings/storefront-url": ["homepage", "layout", "discovery"],
  "/api/v1/admin/settings/hero-sliders": ["homepage"],
  "/api/v1/admin/settings/seo": ["homepage", "layout", "discovery"],
  "/api/v1/admin/settings/security": ["layout"],
  "/api/v1/admin/settings/theme": ["layout"],
  "/api/v1/admin/settings/media": ["media"],
  "/api/v1/admin/settings/currency": ["layout", "checkout"],
  "/api/v1/admin/settings/auth": ["checkout"],
  "/api/v1/admin/settings/email": ["checkout"],
  "/api/v1/admin/settings/sms": ["checkout"],
  "/api/v1/admin/settings/checkout-flow": ["checkout"],
  "/api/v1/admin/settings/allowed-countries": ["checkout"],
  "/api/v1/admin/settings/delivery-locations": ["checkout"],
  "/api/v1/admin/settings/delivery-providers": ["checkout"],
  "/api/v1/admin/settings/payment-methods": ["checkout"],
  "/api/v1/admin/settings/stripe": ["checkout"],
  "/api/v1/admin/settings/sslcommerz": ["checkout"],
  "/api/v1/admin/settings/polar": ["checkout"],
  "/api/v1/admin/settings/shipping-methods": ["checkout", "product-schema"],
  "/api/v1/admin/settings/checkout-languages": ["checkout"],
  "/api/v1/admin/settings/meta-conversions": ["layout"],
  "/api/v1/admin/taxes": ["checkout"],
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

export interface StorefrontWarmResult {
  attempted: boolean;
  ok: boolean;
  paths: string[];
  successful: number;
  skipped: number;
  retryableFailures: string[];
  skippedFailures: string[];
  skippedReason?: "missing-config" | "no-paths";
}

interface StorefrontPurgeBody {
  operationId?: string;
  groups: string[];
  prefixes: string[];
  exactKeys?: string[];
  htmlPaths?: string[];
  bumpVersion: boolean;
  warm?: boolean;
}

interface StorefrontCacheQueueEnqueueResult {
  enqueued: boolean;
  skippedReason?: "missing-config" | "missing-queue";
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

function hasStorefrontPurgeConfig<T extends Pick<Env, "PURGE_URL" | "PURGE_TOKEN">>(
  env?: T,
): env is T & {
  PURGE_URL: string;
  PURGE_TOKEN: string;
} {
  return Boolean(env?.PURGE_URL && env.PURGE_TOKEN);
}

function buildStorefrontGroupPurgeBody(groups: readonly string[]): StorefrontPurgeBody | null {
  const validGroups = groups.filter((g) => g in INVALIDATION_GROUPS);
  if (validGroups.length === 0) return null;

  return {
    groups: validGroups,
    prefixes: getStorefrontPrefixesForGroups(validGroups),
    bumpVersion: shouldBumpStorefrontVersion(validGroups),
  };
}

function buildStorefrontPrefixPurgeBody(
  prefixes: readonly string[],
  options: {
    groups?: readonly string[];
    bumpVersion?: boolean;
    exactKeys?: readonly string[];
    htmlPaths?: readonly string[];
    operationId?: string;
    warm?: boolean;
  } = {},
): StorefrontPurgeBody | null {
  const uniquePrefixes = [...new Set(prefixes.filter(Boolean))];
  const uniqueExactKeys = [...new Set((options.exactKeys ?? []).filter(Boolean))];
  const uniqueHtmlPaths = normalizeStorefrontHtmlPaths(options.htmlPaths ?? []);
  if (
    uniquePrefixes.length === 0 &&
    uniqueExactKeys.length === 0 &&
    uniqueHtmlPaths.length === 0 &&
    options.bumpVersion !== true
  ) {
    return null;
  }

  return {
    ...(options.operationId ? { operationId: options.operationId } : {}),
    groups: [...new Set(options.groups ?? [])],
    prefixes: uniquePrefixes,
    ...(uniqueExactKeys.length > 0 ? { exactKeys: uniqueExactKeys } : {}),
    ...(uniqueHtmlPaths.length > 0 ? { htmlPaths: uniqueHtmlPaths } : {}),
    bumpVersion: options.bumpVersion === true,
    ...(options.warm === false ? { warm: false } : {}),
  };
}

function createStorefrontCachePurgeMessage(
  body: StorefrontPurgeBody,
  source: string,
): StorefrontCachePurgeQueueMessage {
  return {
    type: "storefront.cache_purge",
    operationId: body.operationId ?? crypto.randomUUID(),
    groups: body.groups,
    prefixes: body.prefixes,
    ...(body.exactKeys ? { exactKeys: body.exactKeys } : {}),
    ...(body.htmlPaths ? { htmlPaths: body.htmlPaths } : {}),
    bumpVersion: body.bumpVersion,
    source,
    requestedAt: Date.now(),
  };
}

export async function enqueueStorefrontCachePurge(
  message: StorefrontCacheQueueMessage,
  env?: StorefrontPurgeEnv,
): Promise<StorefrontCacheQueueEnqueueResult> {
  if (!hasStorefrontPurgeConfig(env)) {
    return { enqueued: false, skippedReason: "missing-config" };
  }

  const queue = env.STOREFRONT_CACHE_QUEUE;
  if (typeof queue?.send !== "function") {
    return { enqueued: false, skippedReason: "missing-queue" };
  }

  await queue.send(message);
  return { enqueued: true };
}

export const enqueueStorefrontCacheWarm = enqueueStorefrontCachePurge;

function shouldWarmCriticalPathForPurge(payload: StorefrontCachePurgeQueueMessage): boolean {
  if (payload.bumpVersion) return true;
  const hasExactTargets = Boolean(payload.exactKeys?.length || payload.htmlPaths?.length);
  if (payload.prefixes.length === 0 || hasExactTargets) return false;
  return !(payload.groups.length > 0 && payload.groups.every((group) => group === "checkout"));
}

export function getStorefrontWarmPathsForPurge(
  payload: StorefrontCachePurgeQueueMessage,
): string[] {
  const paths = new Set<string>();
  if (shouldWarmCriticalPathForPurge(payload)) {
    paths.add("/");
  }
  for (const path of normalizeStorefrontHtmlPaths(payload.htmlPaths ?? [])) {
    paths.add(path);
  }
  return [...paths];
}

export function createStorefrontCacheWarmMessageForPurge(
  payload: StorefrontCachePurgeQueueMessage,
): StorefrontCacheWarmQueueMessage | null {
  const paths = getStorefrontWarmPathsForPurge(payload);
  if (paths.length === 0) return null;
  return {
    type: "storefront.cache_warm",
    operationId: payload.operationId,
    paths,
    source: `${payload.source}:warm`,
    requestedAt: Date.now(),
  };
}

function isRetryableWarmStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function warmStorefrontPath(baseUrl: string, path: string): Promise<{
  path: string;
  ok: boolean;
  retryable: boolean;
  status?: number;
  error?: string;
}> {
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: {
        "X-Cache-Warm": "true",
        "Cache-Control": "no-cache",
      },
    });

    if (response.ok) {
      return { path, ok: true, retryable: false, status: response.status };
    }

    return {
      path,
      ok: false,
      retryable: isRetryableWarmStatus(response.status),
      status: response.status,
    };
  } catch (error: unknown) {
    return {
      path,
      ok: false,
      retryable: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type StorefrontWarmPathResult = Awaited<ReturnType<typeof warmStorefrontPath>>;

async function warmStorefrontPathsInBatches(
  baseUrl: string,
  paths: readonly string[],
): Promise<StorefrontWarmPathResult[]> {
  const results: StorefrontWarmPathResult[] = [];

  for (let index = 0; index < paths.length; index += STOREFRONT_WARM_PATH_BATCH_SIZE) {
    const batch = paths.slice(index, index + STOREFRONT_WARM_PATH_BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((path) => warmStorefrontPath(baseUrl, path)),
    );
    results.push(...batchResults);
  }

  return results;
}

export async function warmStorefrontHtmlPaths(
  paths: readonly string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
): Promise<StorefrontWarmResult> {
  const uniquePaths = normalizeStorefrontHtmlPaths(paths);
  if (uniquePaths.length === 0) {
    return {
      attempted: false,
      ok: true,
      paths: [],
      successful: 0,
      skipped: 0,
      retryableFailures: [],
      skippedFailures: [],
      skippedReason: "no-paths",
    };
  }

  if (!hasStorefrontPurgeConfig(env)) {
    return {
      attempted: false,
      ok: false,
      paths: uniquePaths,
      successful: 0,
      skipped: 0,
      retryableFailures: [],
      skippedFailures: [],
      skippedReason: "missing-config",
    };
  }

  const baseUrl = new URL(normalizeStorefrontPurgeUrl(env.PURGE_URL)).origin;
  const results = await warmStorefrontPathsInBatches(baseUrl, uniquePaths);
  const successful = results.filter((result) => result.ok).length;
  const retryableFailures = results
    .filter((result) => !result.ok && result.retryable)
    .map((result) => `${result.path}${result.status ? ` (${result.status})` : ""}${result.error ? ` (${result.error})` : ""}`);
  const skippedFailures = results
    .filter((result) => !result.ok && !result.retryable)
    .map((result) => `${result.path}${result.status ? ` (${result.status})` : ""}`);

  return {
    attempted: true,
    ok: retryableFailures.length === 0,
    paths: uniquePaths,
    successful,
    skipped: skippedFailures.length,
    retryableFailures,
    skippedFailures,
  };
}

function scheduleDirectStorefrontPurgeFallback(
  task: () => Promise<StorefrontPurgeResult>,
  executionCtx: WaitUntilExecutionContext | undefined,
  failureLabel: string,
): void {
  const purgePromise = task().catch((err) => {
    console.error(failureLabel, err);
  });

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(purgePromise);
  } else {
    void purgePromise;
  }
}

async function enqueueStorefrontCachePurgeOrFallback(
  message: StorefrontCachePurgeQueueMessage,
  env: StorefrontPurgeEnv | undefined,
  executionCtx: WaitUntilExecutionContext | undefined,
  fallback: () => Promise<StorefrontPurgeResult>,
  failureLabel: string,
): Promise<void> {
  try {
    const result = await enqueueStorefrontCachePurge(message, env);
    if (result.enqueued || result.skippedReason === "missing-config") {
      return;
    }

    console.warn(
      `[Cache] Durable storefront cache purge queue unavailable (${result.skippedReason}); falling back to direct purge.`,
    );
  } catch (error: unknown) {
    console.error("[Cache] Failed to enqueue storefront cache purge:", error);
  }

  scheduleDirectStorefrontPurgeFallback(fallback, executionCtx, failureLabel);
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
  const body = buildStorefrontGroupPurgeBody(groups);
  if (!body) {
    return { attempted: false, ok: false, skippedReason: "no-valid-groups" };
  }

  if (!hasStorefrontPurgeConfig(env)) {
    return { attempted: false, ok: false, skippedReason: "missing-config" };
  }

  const response = await fetch(normalizeStorefrontPurgeUrl(env.PURGE_URL), {
    method: "POST",
    headers: storefrontPurgeHeaders(env.PURGE_TOKEN),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("[Cache] Storefront group purge failed:", {
      status: response.status,
      groups: body.groups,
    });
  }

  return { attempted: true, ok: response.ok, status: response.status };
}

/**
 * Execute a storefront purge for already-computed logical cache prefixes.
 * This is used by writes where the affected storefront keys can be narrower
 * than a whole invalidation group.
 */
export async function purgeStorefrontForPrefixes(
  prefixes: readonly string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
  options: {
    groups?: readonly string[];
    bumpVersion?: boolean;
    exactKeys?: readonly string[];
    htmlPaths?: readonly string[];
    operationId?: string;
    warm?: boolean;
  } = {},
): Promise<StorefrontPurgeResult> {
  const body = buildStorefrontPrefixPurgeBody(prefixes, options);
  if (!body) {
    return { attempted: false, ok: false, skippedReason: "no-prefixes" };
  }

  if (!hasStorefrontPurgeConfig(env)) {
    return { attempted: false, ok: false, skippedReason: "missing-config" };
  }

  const response = await fetch(normalizeStorefrontPurgeUrl(env.PURGE_URL), {
    method: "POST",
    headers: storefrontPurgeHeaders(env.PURGE_TOKEN),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error("[Cache] Storefront prefix purge failed:", {
      status: response.status,
      groups: body.groups,
      prefixes: body.prefixes,
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
  env?: StorefrontPurgeEnv,
  executionCtx?: WaitUntilExecutionContext,
): void {
  const body = buildStorefrontGroupPurgeBody(groups);
  if (!body || !hasStorefrontPurgeConfig(env)) return;

  const message = createStorefrontCachePurgeMessage(body, "groups");
  const enqueuePromise = enqueueStorefrontCachePurgeOrFallback(
    message,
    env,
    executionCtx,
    () => purgeStorefrontForGroups(body.groups, env),
    "[Cache] Storefront group purge failed:",
  );

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(enqueuePromise);
  } else {
    void enqueuePromise;
  }
}

/**
 * Trigger the storefront purge endpoint for exact storefront cache prefixes.
 * This is the scheduled counterpart to `purgeStorefrontForPrefixes()` for
 * committed writes whose purge should not decide whether the mutation succeeded.
 */
export function triggerStorefrontPurgeForPrefixes(
  prefixes: readonly string[],
  env?: StorefrontPurgeEnv,
  options: {
    groups?: readonly string[];
    bumpVersion?: boolean;
    exactKeys?: readonly string[];
    htmlPaths?: readonly string[];
  } = {},
  executionCtx?: WaitUntilExecutionContext,
): void {
  const body = buildStorefrontPrefixPurgeBody(prefixes, options);
  if (!body || !hasStorefrontPurgeConfig(env)) return;

  const message = createStorefrontCachePurgeMessage(body, "prefixes");
  const enqueuePromise = enqueueStorefrontCachePurgeOrFallback(
    message,
    env,
    executionCtx,
    () =>
      purgeStorefrontForPrefixes(body.prefixes, env, {
        groups: body.groups,
        bumpVersion: body.bumpVersion,
        exactKeys: body.exactKeys,
        htmlPaths: body.htmlPaths,
      }),
    "[Cache] Storefront prefix purge failed:",
  );

  if (executionCtx && typeof executionCtx.waitUntil === "function") {
    executionCtx.waitUntil(enqueuePromise);
  } else {
    void enqueuePromise;
  }
}

export function getOptionalExecutionContext(c: {
  executionCtx?: WaitUntilExecutionContext;
}): WaitUntilExecutionContext | undefined {
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
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
  options: { htmlPaths?: readonly string[] } = {},
): Promise<void> {
  const normalizedGroups = [...groups];
  await invalidateGroups(normalizedGroups, c.env?.CACHE);
  const body = buildStorefrontPrefixPurgeBody(
    getStorefrontPrefixesForGroups(normalizedGroups),
    {
      groups: normalizedGroups,
      bumpVersion: shouldBumpStorefrontVersion(normalizedGroups),
      htmlPaths: options.htmlPaths,
    },
  );
  const executionCtx = getOptionalExecutionContext(c);
  if (!body || !hasStorefrontPurgeConfig(c.env)) return;

  await enqueueStorefrontCachePurgeOrFallback(
    createStorefrontCachePurgeMessage(body, "api-groups"),
    c.env,
    executionCtx,
    () =>
      purgeStorefrontForPrefixes(body.prefixes, c.env, {
        groups: body.groups,
        bumpVersion: body.bumpVersion,
        exactKeys: body.exactKeys,
        htmlPaths: body.htmlPaths,
      }),
    "[Cache] Storefront prefix purge failed:",
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

function uniqueCmsShortcodePageTargets(
  targets: readonly CmsShortcodePageTarget[],
): CmsShortcodePageTarget[] {
  const bySlug = new Map<string, CmsShortcodePageTarget>();
  for (const target of targets) {
    if (!target.slug) continue;
    bySlug.set(target.slug, target);
  }
  return [...bySlug.values()];
}

function cmsShortcodeCandidateCondition(
  productSlugs: readonly string[],
): SQL | undefined {
  if (productSlugs.length === 0) return undefined;
  return sql`lower(${pages.content}) LIKE ${"%[product%"}`;
}

export async function resolveCmsShortcodePageTargets(
  db: Database,
  input: CmsShortcodeReferenceInput,
): Promise<CmsShortcodePageTarget[]> {
  const productSlugs = uniqueValues(input.productSlugs);
  const productSlugSet = new Set(productSlugs);
  const candidateCondition = cmsShortcodeCandidateCondition(productSlugs);
  if (!candidateCondition) return [];

  const rows = await db
    .select({
      id: pages.id,
      slug: pages.slug,
      content: pages.content,
    })
    .from(pages)
    .where(and(publicPageVisibilityCondition(), candidateCondition));

  const targets: CmsShortcodePageTarget[] = [];
  for (const row of rows) {
    const shortcodes = parseShortcodes(row.content ?? "");
    const hasReference = shortcodes.some((shortcode) =>
      productSlugSet.has(shortcode.id),
    );
    if (hasReference) {
      targets.push({ id: row.id, slug: row.slug });
    }
  }

  return uniqueCmsShortcodePageTargets(targets);
}

export function collectCmsShortcodePageInvalidation(
  targets: readonly CmsShortcodePageTarget[],
): CmsShortcodePageInvalidation {
  const uniqueTargets = uniqueCmsShortcodePageTargets(targets);
  return {
    apiPatterns: uniqueTargets.map(
      (target) =>
        `api:storefront:page:/api/v1/storefront/pages/slug/${target.slug}*`,
    ),
    storefrontPrefixes: uniqueTargets.map((target) => `page_render_${target.slug}_`),
    storefrontHtmlPaths: uniqueTargets.map((target) => `/${target.slug}`),
    bumpVersion: uniqueTargets.length > MAX_STOREFRONT_EXACT_HTML_PATHS,
  };
}

async function tryResolveCmsShortcodePageTargets(
  db: Database,
  input: CmsShortcodeReferenceInput,
): Promise<{ targets: CmsShortcodePageTarget[]; failed: boolean }> {
  try {
    return {
      targets: await resolveCmsShortcodePageTargets(db, input),
      failed: false,
    };
  } catch (error) {
    console.error("[Cache] Failed to resolve CMS shortcode page targets:", error);
    return { targets: [], failed: true };
  }
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

function uniqueCollectionCacheTargets(
  targets: readonly CollectionCacheTarget[],
): CollectionCacheTarget[] {
  const byId = new Map<string, CollectionCacheTarget>();
  for (const target of targets) {
    if (!target.id) continue;
    byId.set(target.id, target);
  }
  return [...byId.values()];
}

function chunkValues(values: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < values.length; index += D1_CACHE_SUBJECT_ID_CHUNK_SIZE) {
    chunks.push(values.slice(index, index + D1_CACHE_SUBJECT_ID_CHUNK_SIZE));
  }
  return chunks;
}

/**
 * Resolve active collection detail projections that directly depend on the
 * changed products/categories. Collection config arrays are matched with one
 * bound JSON set per dependency kind, avoiding D1's 100-parameter ceiling.
 */
export async function resolveCollectionCacheTargets(
  db: Database,
  input: CollectionCacheDependencyInput,
): Promise<CollectionCacheTarget[]> {
  const productIds = uniqueValues(input.productIds);
  const categoryIds = uniqueValues(input.categoryIds);
  const dependencyConditions: SQL[] = [];
  const safeCollectionConfig = sql`CASE
    WHEN json_valid(${collections.config}) THEN ${collections.config}
    ELSE '{}'
  END`;

  if (productIds.length > 0) {
    const productIdsJson = JSON.stringify(productIds);
    dependencyConditions.push(sql`(
      (
        json_extract(${safeCollectionConfig}, '$.source') = 'manual'
        AND EXISTS (
          SELECT 1
          FROM json_each(${safeCollectionConfig}, '$.productIds') AS configured_product
          WHERE CAST(configured_product.value AS TEXT) IN (
            SELECT CAST(changed_product.value AS TEXT)
            FROM json_each(${productIdsJson}) AS changed_product
          )
        )
      )
      OR CAST(json_extract(${safeCollectionConfig}, '$.featuredProductId') AS TEXT) IN (
        SELECT CAST(changed_featured.value AS TEXT)
        FROM json_each(${productIdsJson}) AS changed_featured
      )
    )`);
  }

  if (categoryIds.length > 0) {
    const categoryIdsJson = JSON.stringify(categoryIds);
    dependencyConditions.push(sql`(
      json_extract(${safeCollectionConfig}, '$.source') = 'dynamic'
      AND EXISTS (
        SELECT 1
        FROM json_each(${safeCollectionConfig}, '$.categoryIds') AS configured_category
        WHERE CAST(configured_category.value AS TEXT) IN (
          SELECT CAST(changed_category.value AS TEXT)
          FROM json_each(${categoryIdsJson}) AS changed_category
        )
      )
    )`);
  }

  const dependencyCondition = or(...dependencyConditions);
  if (!dependencyCondition) return [];

  const rows = await db
    .selectDistinct({ id: collections.id })
    .from(collections)
    .where(and(
      eq(collections.isActive, true),
      isNull(collections.deletedAt),
      dependencyCondition,
    ));

  return uniqueCollectionCacheTargets(rows);
}

async function tryResolveCollectionCacheTargets(
  db: Database,
  input: CollectionCacheDependencyInput,
): Promise<CollectionCacheTarget[]> {
  try {
    return await resolveCollectionCacheTargets(db, input);
  } catch (error) {
    console.error("[Cache] Failed to resolve collection cache targets:", error);
    return [];
  }
}

export function collectCollectionCacheInvalidation(
  targets: readonly CollectionCacheTarget[],
): CollectionCacheInvalidation {
  const normalizedTargets = uniqueCollectionCacheTargets(targets);
  return {
    apiKeys: normalizedTargets.map(
      (target) => `api:collections:/api/v1/collections/${target.id}`,
    ),
    apiPatterns: normalizedTargets.map(
      (target) => `api:collections:/api/v1/collections/${target.id}?*`,
    ),
    storefrontPrefixes: normalizedTargets.map(
      (target) => `collection_by_id_${target.id}::`,
    ),
    storefrontHtmlPaths: normalizedTargets.map(
      (target) => `/collections/${target.id}`,
    ),
  };
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

  for (const orderIdChunk of chunkValues(orderIds)) {
    const rows = await db
      .selectDistinct({
        productId: products.id,
        slug: products.slug,
        categoryId: products.categoryId,
      })
      .from(orderItems)
      .innerJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIdChunk));
    subjectRows.push(...rows);
  }

  for (const productIdChunk of chunkValues(productIds)) {
    const rows = await db
      .selectDistinct({
        productId: products.id,
        slug: products.slug,
        categoryId: products.categoryId,
      })
      .from(products)
      .where(inArray(products.id, productIdChunk));
    subjectRows.push(...rows);
  }

  for (const variantIdChunk of chunkValues(variantIds)) {
    const rows = await db
      .selectDistinct({
        productId: products.id,
        slug: products.slug,
        categoryId: products.categoryId,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIdChunk));
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
    getProductApiCacheKey(),
    getProductApiCacheKey("feed"),
    getProductApiCacheKey("sitemap"),
    ...normalizedSubjects
      .filter((subject): subject is ProductAvailabilityCacheSubject & { slug: string } =>
        typeof subject.slug === "string" && subject.slug.length > 0,
      )
      .map((subject) => getProductApiCacheKey(subject.slug)),
    getProductApiCacheKey("search"),
  ];
}

export function getProductAvailabilityApiCachePatterns(
  subjects: readonly ProductAvailabilityCacheSubject[],
): string[] {
  const normalizedSubjects = uniqueAvailabilitySubjects(subjects);
  if (normalizedSubjects.length === 0) return [];

  return [
    getProductApiQueryCachePattern(),
    getProductApiQueryCachePattern("feed"),
    getProductApiQueryCachePattern("sitemap"),
    ...normalizedSubjects
      .filter((subject): subject is ProductAvailabilityCacheSubject & { slug: string } =>
        typeof subject.slug === "string" && subject.slug.length > 0,
      )
      .map((subject) => getProductApiQueryCachePattern(subject.slug)),
    getProductApiQueryCachePattern("search"),
    "api:search:*",
  ];
}

export function getProductAvailabilityStorefrontPrefixes(
  subjects: readonly ProductAvailabilityCacheSubject[],
): string[] {
  const prefixes = uniqueAvailabilitySubjects(subjects).flatMap((subject) => [
    ...(subject.slug ? [`product_slug_${subject.slug}`] : []),
    `product_variants_${subject.productId}`,
  ]);

  return prefixes.length > 0
    ? [
        ...prefixes,
        "all_products_",
        "category_products_",
        "feed_products_",
        "sitemap_products_",
      ]
    : [];
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
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
  db?: Database,
): Promise<void> {
  const normalizedSubjects = uniqueAvailabilitySubjects(subjects);
  if (normalizedSubjects.length === 0) return;

  const invalidation = collectProductAvailabilityCacheInvalidation(normalizedSubjects);
  const productSlugs = normalizedSubjects
    .map((subject) => subject.slug)
    .filter((slug): slug is string => typeof slug === "string" && slug.length > 0);
  const shortcodeResult = db && productSlugs.length > 0
    ? await tryResolveCmsShortcodePageTargets(db, { productSlugs })
    : { targets: [], failed: false };
  const shortcodeInvalidation = collectCmsShortcodePageInvalidation(
    shortcodeResult.targets,
  );
  const collectionTargets = db
    ? await tryResolveCollectionCacheTargets(db, {
        productIds: normalizedSubjects.map((subject) => subject.productId),
        categoryIds: normalizedSubjects
          .map((subject) => subject.categoryId)
          .filter((categoryId): categoryId is string => (
            typeof categoryId === "string" && categoryId.length > 0
          )),
      })
    : [];
  const collectionInvalidation = collectCollectionCacheInvalidation(
    collectionTargets,
  );
  const apiKeys = [
    ...invalidation.apiKeys,
    ...collectionInvalidation.apiKeys,
  ];
  const apiPatterns = [
    ...invalidation.apiPatterns,
    ...shortcodeInvalidation.apiPatterns,
    ...collectionInvalidation.apiPatterns,
  ];

  console.log(
    `[Cache] Invalidating product availability for ${normalizedSubjects.length} product(s)`,
  );

  await bumpApiCacheFences(
    [
      ...apiKeys,
      ...apiPatterns
        .map(getApiCacheFenceScopeForPattern)
        .filter((scope): scope is string => Boolean(scope)),
    ],
    c.env?.CACHE,
  );

  await Promise.all([
    ...apiKeys.map((key) =>
      deleteVersionedCacheKeyFamily(key, c.env?.CACHE),
    ),
    ...apiPatterns.map((pattern) =>
      deleteCacheByPattern(pattern, c.env?.CACHE),
    ),
  ]);

  const body = buildStorefrontPrefixPurgeBody(
    shortcodeInvalidation.storefrontPrefixes,
    {
      groups: collectionTargets.length > 0
        ? ["products", "collections"]
        : ["products"],
      bumpVersion: shortcodeInvalidation.bumpVersion || shortcodeResult.failed,
      exactKeys: [
        ...invalidation.storefrontPrefixes,
        ...collectionInvalidation.storefrontPrefixes,
      ],
      htmlPaths: [
        ...invalidation.storefrontHtmlPaths,
        ...shortcodeInvalidation.storefrontHtmlPaths,
        ...collectionInvalidation.storefrontHtmlPaths,
      ],
    },
  );
  const executionCtx = getOptionalExecutionContext(c);
  if (!body || !hasStorefrontPurgeConfig(c.env)) return;

  await enqueueStorefrontCachePurgeOrFallback(
    createStorefrontCachePurgeMessage(body, "product-availability"),
    c.env,
    executionCtx,
    () =>
      purgeStorefrontForPrefixes(body.prefixes, c.env, {
        groups: body.groups,
        bumpVersion: body.bumpVersion,
        exactKeys: body.exactKeys,
        htmlPaths: body.htmlPaths,
      }),
    "[Cache] Storefront prefix purge failed:",
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
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
): Promise<void> {
  const subjects = await tryResolveProductAvailabilityCacheSubjects(db, input);
  await invalidateProductAvailabilityCacheSubjects(subjects, c, db);
}

/**
 * Invalidate the API KV cache and schedule the storefront purge needed after a
 * catalog write. Product and discount changes also clear collection caches
 * because collection pages render product cards, images, and prices.
 */
export async function invalidateCatalogCaches(
  domain: CatalogCacheDomain,
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
  options: CatalogCacheInvalidationOptions = {},
): Promise<void> {
  const groups = [...CATALOG_CACHE_GROUPS[domain]];
  await invalidateGroups(groups, c.env?.CACHE);
  const body = buildStorefrontPrefixPurgeBody(
    getStorefrontPrefixesForGroups(groups),
    {
      groups,
      bumpVersion: shouldBumpStorefrontVersion(groups),
      htmlPaths: getCatalogStorefrontHtmlPaths(domain, options.htmlPaths),
    },
  );
  const executionCtx = getOptionalExecutionContext(c);
  if (!body || !hasStorefrontPurgeConfig(c.env)) return;

  await enqueueStorefrontCachePurgeOrFallback(
    createStorefrontCachePurgeMessage(body, `catalog:${domain}`),
    c.env,
    executionCtx,
    () =>
      purgeStorefrontForPrefixes(body.prefixes, c.env, {
        groups: body.groups,
        bumpVersion: body.bumpVersion,
        exactKeys: body.exactKeys,
        htmlPaths: body.htmlPaths,
      }),
    "[Cache] Storefront prefix purge failed:",
  );
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
