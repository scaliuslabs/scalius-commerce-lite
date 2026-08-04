// src/server/utils/cache-invalidation.ts
import type { Database } from "@scalius/database/client";
import { productVariants } from "@scalius/database/schema";
import { effectiveRegularReservedStockSql } from "@scalius/database/inventory-authority";
import { inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WaitUntilExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
  readonly exports?: {
    PublicApi?: {
      purgeGroups(groups: string[]): Promise<void>;
    };
  };
};

export interface InvalidationGroupDef {
  label: string;
  description: string;
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

export interface CheckoutReservationAvailabilityInput {
  variantId: string;
  quantity: number;
}

type BuyerAvailabilityBand = "out_of_stock" | "low_stock" | "in_stock";

function buyerAvailabilityBand(
  available: number,
  lowStockThreshold: number | null,
): BuyerAvailabilityBand {
  if (available <= 0) return "out_of_stock";
  return lowStockThreshold !== null
      && lowStockThreshold > 0
      && available <= lowStockThreshold
    ? "low_stock"
    : "in_stock";
}

export function hasBuyerAvailabilityBandTransition(input: {
  availableBefore: number;
  availableAfter: number;
  lowStockThreshold: number | null;
}): boolean {
  return buyerAvailabilityBand(
    input.availableBefore,
    input.lowStockThreshold,
  ) !== buyerAvailabilityBand(
    input.availableAfter,
    input.lowStockThreshold,
  );
}

/**
 * Direct checkout is the compatibility lane; the high-throughput coordinator
 * reports transitions without this read. Conservatively return every affected
 * variant if authority cannot be read after the commit.
 */
export async function findCheckoutReservationAvailabilityTransitions(
  db: Database,
  entries: readonly CheckoutReservationAvailabilityInput[],
): Promise<string[]> {
  const quantities = new Map<string, number>();
  for (const entry of entries) {
    if (
      !entry.variantId
      || entry.variantId.length > 180
      || !Number.isSafeInteger(entry.quantity)
      || entry.quantity <= 0
    ) {
      continue;
    }
    quantities.set(
      entry.variantId,
      (quantities.get(entry.variantId) ?? 0) + entry.quantity,
    );
  }
  const variantIds = [...quantities.keys()];
  if (variantIds.length === 0) return [];

  try {
    const rows: Array<{
      id: string;
      stock: number;
      reservedStock: number;
      trackInventory: boolean;
      lowStockThreshold: number | null;
    }> = [];
    for (let offset = 0; offset < variantIds.length; offset += 90) {
      rows.push(...await db
        .select({
          id: productVariants.id,
          stock: productVariants.stock,
          reservedStock: effectiveRegularReservedStockSql(),
          trackInventory: productVariants.trackInventory,
          lowStockThreshold: productVariants.lowStockThreshold,
        })
        .from(productVariants)
        .where(inArray(productVariants.id, variantIds.slice(offset, offset + 90)))
        .all());
    }
    const found = new Set(rows.map((row) => row.id));
    const transitions = rows.filter((row) => {
      if (!row.trackInventory) return false;
      const availableAfter = Math.max(0, row.stock - row.reservedStock);
      return hasBuyerAvailabilityBandTransition({
        availableBefore: availableAfter + quantities.get(row.id)!,
        availableAfter,
        lowStockThreshold: row.lowStockThreshold,
      });
    }).map((row) => row.id);
    for (const variantId of variantIds) {
      if (!found.has(variantId)) transitions.push(variantId);
    }
    return [...new Set(transitions)];
  } catch (error) {
    console.error(
      "[Cache] Checkout availability transition read failed; purging conservatively:",
      error,
    );
    return variantIds;
  }
}

// ---------------------------------------------------------------------------
// Group definitions
// ---------------------------------------------------------------------------

export const INVALIDATION_GROUPS: Record<string, InvalidationGroupDef> = {
  products: {
    label: "Products",
    description:
      "Product listings, search results, and homepage product sections",
  },
  categories: {
    label: "Categories",
    description: "Category pages, navigation menus, and search",
  },
  collections: {
    label: "Collections",
    description: "Collection pages and homepage collection sections",
  },
  pages: {
    label: "Pages",
    description: "Static pages and articles",
  },
  layout: {
    label: "Layout",
    description:
      "Header, footer, navigation, analytics, and site-wide settings",
  },
  media: {
    label: "Media",
    description: "CDN host policy and image optimization settings",
  },
  homepage: {
    label: "Homepage",
    description: "Hero sliders and SEO settings",
  },
  discovery: {
    label: "Discovery",
    description: "SEO policy, robots, sitemap XML, and product feed XML",
  },
  checkout: {
    label: "Checkout",
    description: "Shipping methods, delivery locations, payment settings",
  },
  "product-schema": {
    label: "Product schema",
    description:
      "Product-page commerce facts sourced outside the product aggregate",
  },
  search: {
    label: "Search",
    description: "Search index and filtering",
  },
  attributes: {
    label: "Attributes",
    description: "Product attributes and filterable attributes",
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
  currency: {
    path: "/api/v1/admin/settings/currency",
    groups: ["layout", "checkout"],
    strategy: "shared-projection",
    note: "Layout currency and checkout totals.",
  },
  header: {
    path: "/api/v1/admin/settings/header",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Global storefront header.",
  },
  footer: {
    path: "/api/v1/admin/settings/footer",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Global storefront footer.",
  },
  navigation: {
    path: "/api/v1/admin/navigation",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Header and footer menu trees.",
  },
  business: {
    path: "/api/v1/admin/settings/business",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Public business and schema identity.",
  },
  theme: {
    path: "/api/v1/admin/settings/theme",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Global storefront presentation.",
  },
  media: {
    path: "/api/v1/admin/settings/media",
    groups: ["media"],
    strategy: "shared-projection",
    note: "Layout/homepage image policy.",
  },
  seo: {
    path: "/api/v1/admin/settings/seo",
    groups: ["homepage", "layout", "discovery"],
    strategy: "shared-projection",
    note: "Metadata, discovery and schema.",
  },
  storefrontUrl: {
    path: "/api/v1/admin/settings/storefront-url",
    groups: ["homepage", "layout", "discovery"],
    strategy: "shared-projection",
    note: "Discovery origins plus gw:storefront_url.",
  },
  heroSliders: {
    path: "/api/v1/admin/settings/hero-sliders",
    groups: ["homepage"],
    strategy: "shared-projection",
    note: "Homepage hero.",
  },
  analytics: {
    path: "/api/v1/admin/analytics",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Browser analytics injection.",
  },
  metaConversions: {
    path: "/api/v1/admin/settings/meta-conversions",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "Browser readiness; dispatch reads D1.",
  },
  security: {
    path: "/api/v1/admin/settings/security",
    groups: ["layout"],
    strategy: "shared-projection",
    note: "CSP projections and Partytown write-through.",
  },
  allowedCountries: {
    path: "/api/v1/admin/settings/allowed-countries",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout phone-country policy.",
  },
  checkoutFlow: {
    path: "/api/v1/admin/settings/checkout-flow",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Buyer checkout flow.",
  },
  customerAuth: {
    path: "/api/v1/admin/settings/auth",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Customer sign-in readiness.",
  },
  email: {
    path: "/api/v1/admin/settings/email",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Sign-in readiness; dispatch reads D1.",
  },
  sms: {
    path: "/api/v1/admin/settings/sms",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Sign-in readiness; dispatch reads D1.",
  },
  firebase: {
    path: "/api/v1/admin/settings/firebase",
    groups: [],
    strategy: "credential-scoped",
    note: "D1 settings; OAuth KV key includes credential fingerprint.",
  },
  notificationChannels: {
    path: "/api/v1/admin/settings/notification-channels",
    groups: [],
    strategy: "authoritative-read",
    note: "Dispatch resolves D1 policy.",
  },
  paymentMethods: {
    path: "/api/v1/admin/settings/payment-methods",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Buyer payment allowlist.",
  },
  stripe: {
    path: "/api/v1/admin/settings/stripe",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout plus provider cache.",
  },
  sslcommerz: {
    path: "/api/v1/admin/settings/sslcommerz",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout plus provider cache.",
  },
  polar: {
    path: "/api/v1/admin/settings/polar",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout plus provider cache.",
  },
  shippingMethods: {
    path: "/api/v1/admin/settings/shipping-methods",
    groups: ["checkout", "product-schema"],
    strategy: "shared-projection",
    note: "Checkout and Product shippingDetails.",
  },
  deliveryLocations: {
    path: "/api/v1/admin/settings/delivery-locations",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout location hierarchy.",
  },
  deliveryProviders: {
    path: "/api/v1/admin/settings/delivery-providers",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Delivery readiness; fulfillment reads D1.",
  },
  checkoutLanguages: {
    path: "/api/v1/admin/settings/checkout-languages",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout labels and fields.",
  },
  tax: {
    path: "/api/v1/admin/taxes",
    groups: ["checkout"],
    strategy: "shared-projection",
    note: "Checkout/order tax authority.",
  },
  customerRequests: {
    path: "/api/v1/admin/settings/customer-requests",
    groups: [],
    strategy: "authoritative-read",
    note: "Private eligibility reads D1.",
  },
  fraud: {
    path: "/api/v1/admin/fraud-checker",
    groups: [],
    strategy: "authoritative-read",
    note: "Risk lookup reads D1.",
  },
  cacheOperations: {
    path: "/api/v1/cache",
    groups: [],
    strategy: "cache-operation",
    note: "Purges/replays mutate cache state, not merchant facts.",
  },
} as const satisfies Record<string, SettingsCacheDependencyDef>;

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

export interface StorefrontPurgeResult {
  attempted: boolean;
  ok: boolean;
  status?: number;
  skippedReason?: "no-valid-groups" | "missing-config";
}

const CACHE_PURGE_ATTEMPTS = 3;

function validInvalidationGroups(groups: readonly string[]): string[] {
  return [...new Set(groups.filter((group) => group in INVALIDATION_GROUPS))];
}

function hasStorefrontPurgeConfig(
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
): env is Pick<Env, "PURGE_URL" | "PURGE_TOKEN"> & {
  PURGE_URL: string;
  PURGE_TOKEN: string;
} {
  return Boolean(env?.PURGE_URL && env.PURGE_TOKEN);
}

export function normalizeStorefrontPurgeUrl(purgeUrl: string): string {
  const url = new URL(purgeUrl);
  for (const key of ["token", "purgeToken", "purge_token", "access_token"]) {
    url.searchParams.delete(key);
  }
  return url.toString();
}

/** Purge the named native storefront cache entrypoint by domain tags. */
export async function purgeStorefrontForGroups(
  groups: readonly string[],
  env?: Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
): Promise<StorefrontPurgeResult> {
  const normalizedGroups = validInvalidationGroups(groups);
  if (normalizedGroups.length === 0) {
    return { attempted: false, ok: false, skippedReason: "no-valid-groups" };
  }
  if (!hasStorefrontPurgeConfig(env)) {
    return { attempted: false, ok: false, skippedReason: "missing-config" };
  }

  let lastStatus: number | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CACHE_PURGE_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(normalizeStorefrontPurgeUrl(env.PURGE_URL), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.PURGE_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ groups: normalizedGroups }),
      });
      lastStatus = response.status;
      if (response.ok) {
        return { attempted: true, ok: true, status: response.status };
      }
      await response.body?.cancel();
    } catch (error: unknown) {
      lastError = error;
    }
  }

  console.error("[Cache] Storefront tag purge failed after retries:", {
    status: lastStatus,
    groups: normalizedGroups,
    error: lastError,
  });
  return {
    attempted: true,
    ok: false,
    ...(lastStatus === undefined ? {} : { status: lastStatus }),
  };
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

/** Purge the cache-owning native API entrypoint by bounded domain tags. */
export async function invalidateGroups(
  groups: readonly string[],
  _kv?: KVNamespace,
  options: { cleanupExecutionCtx?: WaitUntilExecutionContext } = {},
): Promise<void> {
  const normalizedGroups = validInvalidationGroups(groups);
  const nativePurger = options.cleanupExecutionCtx?.exports?.PublicApi;
  if (!nativePurger || normalizedGroups.length === 0) return;
  let lastError: unknown;
  for (let attempt = 1; attempt <= CACHE_PURGE_ATTEMPTS; attempt += 1) {
    try {
      await nativePurger.purgeGroups(normalizedGroups);
      return;
    } catch (error: unknown) {
      lastError = error;
    }
  }
  console.error("[Cache] Public API tag purge failed after retries:", lastError);
}

/** Purge both public Workers after a committed merchant mutation. */
export async function invalidateApiAndStorefrontGroups(
  groups: readonly string[],
  env?: Env,
  options: {
    cleanupExecutionCtx?: WaitUntilExecutionContext;
  } = {},
): Promise<StorefrontPurgeResult> {
  const normalizedGroups = validInvalidationGroups(groups);
  const [, storefrontResult] = await Promise.all([
    invalidateGroups(normalizedGroups, env?.CACHE, {
      cleanupExecutionCtx: options.cleanupExecutionCtx,
    }),
    purgeStorefrontForGroups(normalizedGroups, env),
  ]);
  return storefrontResult;
}

export async function invalidateApiAndScheduleStorefrontGroups(
  groups: readonly string[],
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
): Promise<void> {
  await invalidateApiAndStorefrontGroups(groups, c.env, {
    cleanupExecutionCtx: getOptionalExecutionContext(c),
  });
}

export async function invalidateProductAvailabilityCacheSubjects(
  subjects: readonly ProductAvailabilityCacheSubject[],
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
  _db?: Database,
): Promise<void> {
  if (subjects.length === 0) return;
  await invalidateApiAndStorefrontGroups(["products"], c.env, {
    cleanupExecutionCtx: getOptionalExecutionContext(c),
  });
}

export async function invalidateProductAvailabilityCaches(
  _db: Database,
  input: ProductAvailabilityCacheInput,
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
): Promise<void> {
  if (!input.orderIds?.length && !input.productIds?.length && !input.variantIds?.length) return;
  await invalidateApiAndStorefrontGroups(["products"], c.env, {
    cleanupExecutionCtx: getOptionalExecutionContext(c),
  });
}

export async function invalidateCatalogCaches(
  domain: CatalogCacheDomain,
  c: { env?: Env; executionCtx?: WaitUntilExecutionContext },
): Promise<void> {
  await invalidateApiAndStorefrontGroups(CATALOG_CACHE_GROUPS[domain], c.env, {
    cleanupExecutionCtx: getOptionalExecutionContext(c),
  });
}
