import type { HeroSliderImage, HomepageHero } from "./api/storefront";

export interface ResolvedHomepageHero {
  desktop: HeroSliderImage[];
  mobile: HeroSliderImage[];
}

/**
 * Banner slides per viewport. Phones reuse the desktop banners (cropped
 * around each slide's focal point) when the merchant added no phone banners,
 * so a phone never gets an empty hero while desktop has one.
 */
export function resolveHomepageHero(
  hero: HomepageHero | null | undefined,
): ResolvedHomepageHero {
  const desktop = hero?.desktop?.images ?? [];
  const mobile = hero?.mobile?.images ?? [];
  return { desktop, mobile: mobile.length > 0 ? mobile : desktop };
}
