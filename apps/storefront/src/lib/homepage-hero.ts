import {
  HERO_SLIDE_PRESENTATION,
  type HeroSlideViewport,
} from "@scalius/shared/hero-slider";
import type { StorefrontSectionOf } from "@scalius/shared/storefront-theme";
import type { HeroSliderImage, HomepageHero } from "./api/storefront";
import { mediaImageSrcSet, mediaImageUrl } from "./media-url";
import { capSizesDensity } from "./responsive-image";

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
  layout: StorefrontHeroLayout = "contained-banners",
): HeroImageCandidate {
  return {
    src: mediaImageUrl(url, HERO_SLIDE_PRESENTATION[viewport].width),
    srcset: mediaImageSrcSet(url),
    // The banner is the home LCP: DPR 3 phones fetch about 2x pixels.
    sizes: capSizesDensity(heroImageSizes(layout, viewport)),
    media: HERO_VIEWPORT_MEDIA[viewport],
  };
}

export type StorefrontHeroLayout = StorefrontSectionOf<"hero">["settings"]["layout"];

/**
 * The banner's rendered width per hero layout. Contained heroes (with side
 * banners or the facts panel beside them) keep the container sizes, which
 * are never smaller than the banner; full-bleed and full-screen heroes span
 * the viewport; split heroes show two halves on computers; story cards are
 * rail cards (STORY_CARD_SIZES).
 */
export function heroImageSizes(layout: StorefrontHeroLayout, viewport: HeroSlideViewport): string {
  switch (layout) {
    case "full-bleed":
    case "full-screen":
      return "100vw";
    case "split":
      return viewport === "desktop" ? "50vw" : "100vw";
    case "story-cards":
      return STORY_CARD_SIZES;
    default:
      return HERO_IMAGE_SIZES[viewport];
  }
}

/** Story-card widths (hero.astro): 62% of a phone, then 40%, 25% and 19% (Amazon's 5.3 visible). */
export const STORY_CARD_SIZES =
  "(max-width: 639px) 62vw, (max-width: 1023px) 40vw, (max-width: 1279px) 25vw, 19vw";

/**
 * The first banner of each viewport, as the hero paints it: the LCP
 * preload offers exactly these candidates, so the browser never fetches a
 * second file for the same slot. Story cards show the computer banners on
 * every screen, so they have one candidate without a media query.
 */
export function heroLeadCandidates(hero: ResolvedHomepageHero, layout: StorefrontHeroLayout): HeroImageCandidate[] {
  if (layout === "story-cards") {
    const first = hero.desktop[0] ?? hero.mobile[0];
    if (!first) return [];
    return [{ ...heroImageCandidate(first.url, "desktop", layout), media: "all" }];
  }
  return [
    hero.mobile[0] ? heroImageCandidate(hero.mobile[0].url, "mobile", layout) : null,
    hero.desktop[0] ? heroImageCandidate(hero.desktop[0].url, "desktop", layout) : null,
  ].filter((candidate): candidate is HeroImageCandidate => Boolean(candidate?.src));
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
