import type { HomepageData } from "./api/storefront";

/** Core resolves only public landing products; an unavailable one leaves the catalog home. */
export function homepageLandingPath(presentation: HomepageData["presentation"]): string | null {
  const slug = presentation.landingProduct?.slug;
  return presentation.homeMode === "landing" && slug && slug !== "." && slug !== ".."
    ? `/products/${encodeURIComponent(slug)}`
    : null;
}
