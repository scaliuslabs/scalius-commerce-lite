/**
 * Every cached public read the harness exercises (each route family of
 * `PUBLIC_API_CACHE_ROUTES` with representative queries for the seeded
 * store), and the storefront pages composed from them the way the storefront
 * batch composes a render.
 */
import { isPublicApiCacheRoute, withMarketPresence } from "@scalius/shared/public-api-cache-routes";
import { DVC_IDS } from "./seed-store";

const LIST = "page=1&limit=20";

function productParts(): string[] {
  const parts = [
    `/api/v1/products?${LIST}&sort=newest`,
    `/api/v1/products?${LIST}&sort=price-asc`,
    `/api/v1/products?${LIST}&sort=price-desc`,
    `/api/v1/products?${LIST}&sort=name-asc`,
    `/api/v1/products?${LIST}&sort=discount`,
    `/api/v1/products?${LIST}&search=panjabi`,
    `/api/v1/products?${LIST}&search=silk&sort=relevance`,
    `/api/v1/products?${LIST}&category=panjabi&sort=newest`,
    `/api/v1/products?${LIST}&hasDiscount=true`,
    `/api/v1/products?${LIST}&minPrice=1000&maxPrice=3000`,
    `/api/v1/products?ids=p_linen,p_silk,p_bag`,
    "/api/v1/products/search?search=linen",
    "/api/v1/products/feed",
    // Each catalogue channel's feed (MARKETS-DESIGN D6): its publications and locations.
    "/api/v1/products/feed?channel=sc_meta",
    "/api/v1/products/feed?channel=sc_agents&ids=p_linen,p_bag,p_shoe",
    "/api/v1/products/sitemap",
    "/api/v1/products/recommendations?limit=8",
    "/api/v1/products/recommendations?productIds=p_linen&limit=8",
    "/api/v1/products/compare?ids=p_linen,p_cotton,p_silk",
    "/api/v1/products/linen-panjabi/sections/variants",
    "/api/v1/products/silk-panjabi/sections/options",
    "/api/v1/products/linen-panjabi/sections/related_products",
    "/api/v1/products/linen-panjabi/sections/additional_info",
  ];
  for (const slug of DVC_IDS.productSlugs) parts.push(`/api/v1/products/${slug}`);
  return parts;
}

function categoryParts(): string[] {
  const parts = [
    "/api/v1/categories",
    "/api/v1/categories/summaries",
    "/api/v1/categories/tree",
  ];
  for (const slug of DVC_IDS.categorySlugs) {
    parts.push(
      `/api/v1/categories/${slug}`,
      `/api/v1/categories/${slug}/products?${LIST}&sort=newest`,
    );
  }
  parts.push(
    `/api/v1/categories/men/products?${LIST}&sort=price-asc`,
    `/api/v1/categories/panjabi/products?${LIST}&sort=price-desc&material=linen`,
    "/api/v1/categories/men/children",
    "/api/v1/categories/festive-panjabi/breadcrumb",
    "/api/v1/categories/panjabi/sections/summary",
    "/api/v1/categories/panjabi/sections/text?field=description",
    `/api/v1/categories/panjabi/product-summaries?${LIST}`,
  );
  return parts;
}

function otherParts(): string[] {
  return [
    "/api/v1/brands",
    "/api/v1/brands/sitemap",
    "/api/v1/brands/aarong",
    "/api/v1/brands/yellow",
    `/api/v1/brands/aarong/products?${LIST}`,
    "/api/v1/collections",
    "/api/v1/collections/col_manual",
    "/api/v1/collections/col_dynamic",
    "/api/v1/collections/col_hidden",
    "/api/v1/storefront/homepage",
    "/api/v1/storefront/layout",
    ...DVC_IDS.landingSlugs.map((slug) => `/api/v1/storefront/landing/${slug}`),
    "/api/v1/storefront/pages/slug/about",
    "/api/v1/checkout/config",
    // The one market-keyed read: the India market's subfolder.
    "/api/v1/checkout/config?presence=en-in",
    "/api/v1/storefront/markets",
    "/api/v1/storefront/app-blocks/checkout",
    "/api/v1/checkout-languages/active",
    "/api/v1/shipping-methods",
    // A destination's zone: a Bangladesh place, and abroad by postal prefix, admin area and country.
    "/api/v1/shipping-methods?cityId=loc_dhaka&zoneId=loc_mirpur",
    "/api/v1/shipping-methods?countryCode=US&adminArea=CA&postalCode=94103",
    "/api/v1/shipping-methods?countryCode=US&postalCode=97201",
    "/api/v1/locations/cities",
    "/api/v1/locations/zones?cityId=loc_dhaka",
    "/api/v1/locations/areas?zoneId=loc_mirpur",
    // Address rules are code: a release, never a write, changes them.
    "/api/v1/address-rules/US",
    "/api/v1/attributes/category/cat_panjabi",
    "/api/v1/attributes/category-slug/panjabi",
    "/api/v1/attributes/search-filters",
    "/api/v1/pages",
    "/api/v1/pages/slug/about",
    "/api/v1/pages/page_ship",
    "/api/v1/articles",
    "/api/v1/articles/slug/eid-lookbook",
    "/api/v1/seo",
    "/api/v1/navigation",
    "/api/v1/navigation/placements",
    "/api/v1/navigation/menus/menu_main?revision=1&dependencyRevision=1",
    "/api/v1/navigation/menus/menu_main/items?revision=1&dependencyRevision=1",
    "/api/v1/navigation/menu_footer",
  ];
}

/**
 * The India presence's priced reads (MARKETS-DESIGN D5): FX-derived prices,
 * its market list (with a quantity break), its scheduled sale, and the draft
 * and segment lists no public read applies.
 */
function presenceParts(): string[] {
  const presence = "presence=en-in";
  // One part per priced code path; the page catalogue adds the presence pages.
  return [
    `/api/v1/products?${LIST}&sort=newest&${presence}`,
    `/api/v1/products?${LIST}&sort=price-asc&${presence}`,
    `/api/v1/products?${LIST}&minPrice=1000&maxPrice=3000&${presence}`,
    `/api/v1/products/search?search=linen&${presence}`,
    `/api/v1/products/feed?${presence}`,
    `/api/v1/products/recommendations?productIds=p_linen&limit=8&${presence}`,
    `/api/v1/products/compare?ids=p_linen,p_cotton,p_silk&${presence}`,
    `/api/v1/products/linen-panjabi/sections/variants?${presence}`,
    ...["linen-panjabi", "silk-panjabi"].map((slug) => `/api/v1/products/${slug}?${presence}`),
    `/api/v1/categories/panjabi/products?${LIST}&sort=newest&${presence}`,
    `/api/v1/collections/col_dynamic?${presence}`,
    `/api/v1/storefront/homepage?${presence}`,
    `/api/v1/storefront/layout?${presence}`,
    `/api/v1/shipping-methods?${presence}`,
  ];
}

/**
 * The Bangla presence of the India market (MARKETS-DESIGN D9): every read
 * that folds a translation or resolves a localized handle, in its language.
 */
function languageParts(): string[] {
  const presence = "presence=bn-in";
  return [
    `/api/v1/products?${LIST}&sort=newest&${presence}`,
    `/api/v1/products/search?search=linen&${presence}`,
    `/api/v1/products/feed?${presence}`,
    `/api/v1/products/sitemap?${presence}`,
    // The localized handle of a product.
    `/api/v1/products/linen-panjabi-bn?${presence}`,
    `/api/v1/products/silk-panjabi?${presence}`,
    // A French handle: another language's handle still reaches the product.
    `/api/v1/products/panjabi-soie?${presence}`,
    `/api/v1/products/silk-panjabi/sections/options?${presence}`,
    `/api/v1/categories/tree?${presence}`,
    `/api/v1/categories/panjabi-bn?${presence}`,
    `/api/v1/categories/panjabi-bn/products?${LIST}&sort=newest&${presence}`,
    `/api/v1/brands/aarong-bn?${presence}`,
    `/api/v1/collections/col_manual?${presence}`,
    `/api/v1/storefront/homepage?${presence}`,
    `/api/v1/storefront/layout?${presence}`,
    `/api/v1/storefront/pages/slug/amader-kotha?${presence}`,
    `/api/v1/articles/slug/eid-lookbook?${presence}`,
    `/api/v1/navigation?${presence}`,
    `/api/v1/shipping-methods?${presence}`,
    `/api/v1/checkout/config?${presence}`,
    `/api/v1/checkout-languages/active?${presence}`,
  ];
}

/** Every part the harness caches, in a stable order. */
export function dvcPartCatalogue(): string[] {
  const parts = [...productParts(), ...categoryParts(), ...otherParts(), ...presenceParts(), ...languageParts()];
  const unique = [...new Set(parts)];
  const notCached = unique.filter((part) => !isPublicApiCacheRoute(new URL(part, "https://api.internal")));
  if (notCached.length > 0) throw new Error(`Not public cached routes: ${notCached.join(", ")}`);
  return unique;
}

export interface DvcPage {
  readonly name: string;
  readonly parts: readonly string[];
}

const SHELL = ["/api/v1/storefront/layout"];
const COMMERCE = ["/api/v1/shipping-methods", "/api/v1/checkout/config"];

/** A presence page's reads: the layout and its own, the market-keyed ones with the presence. */
function presenceShell(presence: string, ...parts: string[]): string[] {
  return [...SHELL, ...parts].map((part) => {
    const url = withMarketPresence(new URL(part, "https://api.internal"), presence);
    return `${url.pathname}${url.search}`;
  });
}

/** Storefront pages as the batch composes them (layout plus the page's reads). */
export function dvcPageCatalogue(): DvcPage[] {
  const pages: DvcPage[] = [
    { name: "home", parts: [...SHELL, "/api/v1/storefront/homepage", ...COMMERCE] },
    // A presence page: every market-keyed read carries the presence.
    { name: "home:en-in", parts: presenceShell("en-in", "/api/v1/storefront/homepage", ...COMMERCE) },
    { name: "product:linen-panjabi:en-in", parts: presenceShell("en-in", "/api/v1/products/linen-panjabi", ...COMMERCE) },
    { name: "shop-all-price:en-in", parts: presenceShell("en-in", `/api/v1/products?${LIST}&sort=price-asc`) },
    // The Bangla presence: translated text and localized handles.
    { name: "home:bn-in", parts: presenceShell("bn-in", "/api/v1/storefront/homepage", ...COMMERCE) },
    { name: "product:linen-panjabi-bn:bn-in", parts: presenceShell("bn-in", "/api/v1/products/linen-panjabi-bn", ...COMMERCE) },
    { name: "category:panjabi-bn:bn-in", parts: presenceShell("bn-in", "/api/v1/categories/panjabi-bn", `/api/v1/categories/panjabi-bn/products?${LIST}&sort=newest`) },
    { name: "cms:amader-kotha:bn-in", parts: presenceShell("bn-in", "/api/v1/storefront/pages/slug/amader-kotha") },
    { name: "cart-shell:bn-in", parts: presenceShell("bn-in", ...COMMERCE, "/api/v1/checkout-languages/active", "/api/v1/locations/cities") },
    { name: "feed:en-in", parts: [`/api/v1/products/feed?presence=en-in`, "/api/v1/seo"] },
    { name: "search", parts: [...SHELL, `/api/v1/products?${LIST}&search=panjabi`] },
    { name: "shop-all-price", parts: [...SHELL, `/api/v1/products?${LIST}&sort=price-asc`] },
    { name: "collection", parts: [...SHELL, "/api/v1/collections/col_manual"] },
    { name: "collection-dynamic", parts: [...SHELL, "/api/v1/collections/col_dynamic"] },
    { name: "brand", parts: [...SHELL, "/api/v1/brands/aarong", `/api/v1/brands/aarong/products?${LIST}`] },
    { name: "cms", parts: [...SHELL, "/api/v1/storefront/pages/slug/about"] },
    { name: "landing", parts: [...SHELL, "/api/v1/storefront/landing/eid", ...COMMERCE] },
    { name: "article", parts: [...SHELL, "/api/v1/articles/slug/eid-lookbook"] },
    { name: "cart-shell", parts: [...SHELL, ...COMMERCE, "/api/v1/checkout-languages/active", "/api/v1/locations/cities"] },
    { name: "checkout-shell", parts: [...SHELL, "/api/v1/checkout/config", "/api/v1/checkout-languages/active"] },
    { name: "sitemap-products", parts: ["/api/v1/products/sitemap"] },
    { name: "feed", parts: ["/api/v1/products/feed", "/api/v1/seo"] },
    { name: "feed:meta", parts: ["/api/v1/products/feed?channel=sc_meta", "/api/v1/seo"] },
  ];
  for (const slug of DVC_IDS.productSlugs.slice(0, 8)) {
    pages.push({ name: `product:${slug}`, parts: [...SHELL, `/api/v1/products/${slug}`, ...COMMERCE] });
  }
  for (const slug of ["men", "panjabi", "festive-panjabi", "saree"]) {
    pages.push({ name: `category:${slug}`, parts: [...SHELL, `/api/v1/categories/${slug}`, `/api/v1/categories/${slug}/products?${LIST}&sort=newest`] });
  }
  return pages;
}
