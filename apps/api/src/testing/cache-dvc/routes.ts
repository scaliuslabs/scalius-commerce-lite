/**
 * Every cached public read the harness exercises (each route family of
 * `PUBLIC_API_CACHE_ROUTES` with representative queries for the seeded
 * store), and the storefront pages composed from them the way the storefront
 * batch composes a render.
 */
import { isPublicApiCacheRoute } from "@scalius/shared/public-api-cache-routes";
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
    "/api/v1/storefront/pages/slug/about",
    "/api/v1/storefront/pages/slug/eid-lookbook",
    "/api/v1/checkout/config",
    "/api/v1/checkout-languages/active",
    "/api/v1/shipping-methods",
    "/api/v1/locations/cities",
    "/api/v1/locations/zones?cityId=loc_dhaka",
    "/api/v1/locations/areas?zoneId=loc_mirpur",
    "/api/v1/attributes/category/cat_panjabi",
    "/api/v1/attributes/category-slug/panjabi",
    "/api/v1/attributes/search-filters",
    "/api/v1/pages",
    "/api/v1/pages/slug/about",
    "/api/v1/pages/page_ship",
    "/api/v1/articles",
    "/api/v1/articles/slug/eid-lookbook",
    "/api/v1/hero/sliders?type=desktop",
    "/api/v1/hero/sliders?type=mobile",
    "/api/v1/hero/sliders/hero_desktop",
    "/api/v1/seo",
    "/api/v1/header",
    "/api/v1/footer",
    "/api/v1/navigation",
    "/api/v1/navigation/placements",
    "/api/v1/navigation/menus/menu_main",
    "/api/v1/navigation/menus/menu_main/items",
    "/api/v1/navigation/menu_footer",
  ];
}

/** Every part the harness caches, in a stable order. */
export function dvcPartCatalogue(): string[] {
  const parts = [...productParts(), ...categoryParts(), ...otherParts()];
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

/** Storefront pages as the batch composes them (layout plus the page's reads). */
export function dvcPageCatalogue(): DvcPage[] {
  const pages: DvcPage[] = [
    { name: "home", parts: [...SHELL, "/api/v1/storefront/homepage", ...COMMERCE] },
    { name: "search", parts: [...SHELL, `/api/v1/products?${LIST}&search=panjabi`] },
    { name: "shop-all-price", parts: [...SHELL, `/api/v1/products?${LIST}&sort=price-asc`] },
    { name: "collection", parts: [...SHELL, "/api/v1/collections/col_manual"] },
    { name: "collection-dynamic", parts: [...SHELL, "/api/v1/collections/col_dynamic"] },
    { name: "brand", parts: [...SHELL, "/api/v1/brands/aarong", `/api/v1/brands/aarong/products?${LIST}`] },
    { name: "cms", parts: [...SHELL, "/api/v1/storefront/pages/slug/about"] },
    { name: "article", parts: [...SHELL, "/api/v1/storefront/pages/slug/eid-lookbook"] },
    { name: "cart-shell", parts: [...SHELL, ...COMMERCE, "/api/v1/checkout-languages/active", "/api/v1/locations/cities"] },
    { name: "sitemap-products", parts: ["/api/v1/products/sitemap"] },
    { name: "feed", parts: ["/api/v1/products/feed", "/api/v1/seo"] },
  ];
  for (const slug of DVC_IDS.productSlugs.slice(0, 8)) {
    pages.push({ name: `product:${slug}`, parts: [...SHELL, `/api/v1/products/${slug}`, ...COMMERCE] });
  }
  for (const slug of ["men", "panjabi", "festive-panjabi", "saree"]) {
    pages.push({ name: `category:${slug}`, parts: [...SHELL, `/api/v1/categories/${slug}`, `/api/v1/categories/${slug}/products?${LIST}&sort=newest`] });
  }
  return pages;
}
