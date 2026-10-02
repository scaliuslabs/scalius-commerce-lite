import type { StorefrontHomeMode } from "@scalius/shared/storefront-theme";
import type { HomepageProduct } from "./api/storefront";

/**
 * Where `/` sends a product homepage: the product's own page, while the API
 * resolves the theme's product as public (`homeProduct`, the same id). Any
 * other case renders the sections. The product page keeps its own canonical
 * and never redirects to `/`, so there is no loop.
 */
export function homepageLandingPath(
  homeMode: StorefrontHomeMode,
  homeProduct: HomepageProduct | null | undefined,
): string | null {
  if (homeMode.kind !== "product" || !homeProduct || homeProduct.id !== homeMode.productId) return null;
  const slug = homeProduct.slug;
  return slug && slug !== "." && slug !== ".." ? `/products/${encodeURIComponent(slug)}` : null;
}
