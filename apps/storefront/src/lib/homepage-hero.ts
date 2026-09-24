import {
  HERO_SLIDE_PRESENTATION,
  type HeroSlideViewport,
} from "@scalius/shared/hero-slider";
import type { HeroSliderImage, HomepageHero } from "./api/storefront";
import { mediaImageSrcSet, mediaImageUrl } from "./media-url";

/**
 * Rendered banner width per viewport: hero.astro's max-w-7xl (80rem)
 * container minus its side padding (px-4, sm:px-6, lg:px-8). Phones get the
 * phone banner below md (48rem), everything wider the desktop banner.
 */
export const HERO_IMAGE_SIZES: Record<HeroSlideViewport, string> = {
  mobile: "calc(100vw - 2rem)",
  desktop: "(min-width: 80rem) 76rem, (min-width: 64rem) calc(100vw - 4rem), calc(100vw - 3rem)",
};

export const HERO_VIEWPORT_MEDIA: Record<HeroSlideViewport, string> = {
  mobile: "(max-width: 767px)",
  desktop: "(min-width: 768px)",
};

export interface HeroImageCandidate {
  /** Fallback single URL (the rendition at the authored slide width). */
  src: string;
  /** Every pre-generated rendition; undefined for images without renditions. */
  srcset?: string;
  sizes: string;
  media: string;
}

/**
 * One source of truth for a banner's `<source>` and its LCP preload
 * (`imagesrcset`/`imagesizes`), so the browser picks the same candidate for
 * both and never downloads the banner twice.
 */
export function heroImageCandidate(
  url: string,
  viewport: HeroSlideViewport,
): HeroImageCandidate {
  return {
    src: mediaImageUrl(url, HERO_SLIDE_PRESENTATION[viewport].width),
    srcset: mediaImageSrcSet(url),
    sizes: HERO_IMAGE_SIZES[viewport],
    media: HERO_VIEWPORT_MEDIA[viewport],
  };
}

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
