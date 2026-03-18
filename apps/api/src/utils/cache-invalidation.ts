// src/server/utils/cache-invalidation.ts
import { deleteCacheByPattern } from "./kv-cache";

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

// ---------------------------------------------------------------------------
// Group definitions
// ---------------------------------------------------------------------------

export const INVALIDATION_GROUPS: Record<string, InvalidationGroupDef> = {
  products: {
    label: "Products",
    description: "Product listings, search results, and homepage product sections",
    kvPrefixes: ["api:products:", "api:search:", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: ["product_slug_", "product_variants_", "all_products_", "category_products_", "storefront_homepage_"],
  },
  categories: {
    label: "Categories",
    description: "Category pages, navigation menus, and search",
    kvPrefixes: ["api:categories:", "api:navigation:", "api:search:", "api:attributes:category", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: ["category_slug_", "global_all_categories", "category_products_", "filterable_attrs_category_", "storefront_homepage_"],
  },
  collections: {
    label: "Collections",
    description: "Collection pages and homepage collection sections",
    kvPrefixes: ["api:collections:", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: ["global_all_collections", "collection_by_id_", "storefront_homepage_"],
  },
  pages: {
    label: "Pages",
    description: "Static content pages",
    kvPrefixes: ["api:pages:"],
    bumpsHtml: true,
    storefrontPrefixes: ["page_slug_", "all_pages_"],
  },
  layout: {
    label: "Layout",
    description: "Header, footer, navigation, analytics, and site-wide settings",
    kvPrefixes: ["api:header:", "api:footer:", "api:navigation:", "api:analytics:", "api:storefront:layout:", "api:storefront:csp:"],
    bumpsHtml: true,
    storefrontPrefixes: ["storefront_layout_", "global_header_data", "global_footer_data", "global_navigation_", "global_analytics_config", "global_security_settings"],
  },
  homepage: {
    label: "Homepage",
    description: "Hero sliders, widgets, SEO settings",
    kvPrefixes: ["api:hero:", "api:widgets:active-homepage:", "api:widgets:single:", "api:seo:", "api:storefront:homepage:"],
    bumpsHtml: true,
    storefrontPrefixes: ["homepage_hero_sliders", "global_homepage_widgets", "widget_", "global_seo_settings", "storefront_homepage_"],
  },
  checkout: {
    label: "Checkout",
    description: "Shipping methods, delivery locations, payment settings",
    kvPrefixes: ["api:shipping-methods:", "api:locations:"],
    bumpsHtml: false,
    storefrontPrefixes: ["global_shipping_cities", "shipping_zones_", "shipping_areas_", "global_shipping_methods", "checkout_config", "global_checkout_language"],
  },
  search: {
    label: "Search",
    description: "Search index and filtering",
    kvPrefixes: ["api:search:"],
    bumpsHtml: true,
    storefrontPrefixes: ["all_products_", "filterable_attrs_"],
  },
  attributes: {
    label: "Attributes",
    description: "Product attributes and filterable attributes",
    kvPrefixes: ["api:attributes:filterable", "api:attributes:category", "api:attributes:category-slug"],
    bumpsHtml: true,
    storefrontPrefixes: ["filterable_attrs_"],
  },
};

// ---------------------------------------------------------------------------
// Admin path → group mapping
// ---------------------------------------------------------------------------

export const ADMIN_PATH_TO_GROUPS: Record<string, string[]> = {
  "/api/v1/admin/products": ["products", "search"],
  "/api/inventory": ["products"],
  "/api/v1/admin/categories": ["categories", "search"],
  "/api/v1/admin/collections": ["collections"],
  "/api/v1/admin/pages": ["pages"],
  "/api/v1/admin/widgets": ["homepage"],
  "/api/v1/admin/navigation": ["layout"],
  "/api/v1/admin/analytics": ["layout"],
  "/api/v1/admin/settings/header": ["layout"],
  "/api/v1/admin/settings/footer": ["layout"],
  "/api/v1/admin/settings/hero-sliders": ["homepage"],
  "/api/v1/admin/settings/seo": ["homepage"],
  "/api/v1/admin/settings/security": ["layout"],
  "/api/v1/admin/settings/theme": ["layout"],
  "/api/v1/admin/settings/currency": ["layout", "products"],
  "/api/v1/admin/settings/auth": ["checkout"],
  "/api/v1/admin/settings/delivery-locations": ["checkout"],
  "/api/v1/admin/settings/delivery-providers": ["checkout"],
  "/api/v1/admin/settings/payment-methods": ["checkout"],
  "/api/v1/admin/settings/stripe": ["checkout"],
  "/api/v1/admin/settings/sslcommerz": ["checkout"],
  "/api/v1/admin/settings/shipping-methods": ["checkout"],
  "/api/v1/admin/settings/checkout-languages": ["checkout"],
  "/api/v1/admin/settings/meta-conversions": ["layout"],
  "/api/v1/admin/attributes": ["attributes", "products", "categories"],
  "/api/v1/admin/discounts": ["products"],
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

  console.log(`[Cache] Invalidating groups [${groups.join(", ")}] – ${uniquePrefixes.length} KV prefix(es)`);

  await Promise.all(
    uniquePrefixes.map((prefix) => deleteCacheByPattern(`${prefix}*`, kv)),
  );
}

/**
 * Clear the entire API cache (all keys under the project prefix).
 */
export async function invalidateEntireCache(kv?: KVNamespace): Promise<void> {
  try {
    await deleteCacheByPattern("*", kv);
    console.log("[Cache] Successfully cleared the entire project cache.");
  } catch (error: unknown) {
    console.error("[Cache] Error clearing the entire project cache:", error);
  }
}
