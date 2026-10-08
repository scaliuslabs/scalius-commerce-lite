import {
  HERO_SLIDE_PRESENTATION,
  type HeroSlide,
  type HeroSlideViewport,
} from "@scalius/shared/hero-slider";
import type { StorefrontHeroSlide, StorefrontSectionOf } from "@scalius/shared/storefront-theme";
import type { HomepageMediaAsset } from "./api/storefront";
import { mediaImageSrcSet, mediaImageUrl } from "./media-url";
import { capSizesDensity } from "./responsive-image";

/**
 * Rendered banner width per viewport: hero.astro's contained banner, the
 * page container (up to 80rem) minus its gutters (16, 24 and 32px). Phones get the
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
 * the viewport; split heroes show two halves on computers.
 */
export function heroImageSizes(layout: StorefrontHeroLayout, viewport: HeroSlideViewport): string {
  switch (layout) {
    case "full-bleed":
    case "full-screen":
      return "100vw";
    case "split":
      return viewport === "desktop" ? "50vw" : "100vw";
    case "wide-editorial":
      return viewport === "desktop"
        ? "(min-width: 97rem) 93rem, calc(100vw - 4rem)"
        : "calc(100vw - 2rem)";
    default:
      return HERO_IMAGE_SIZES[viewport];
  }
}

/**
 * The first banner of each viewport, as the hero paints it: the LCP
 * preload offers exactly these candidates, so the browser never fetches a
 * second file for the same slot.
 */
export function heroLeadCandidates(hero: ResolvedHomepageHero, layout: StorefrontHeroLayout): HeroImageCandidate[] {
  return [
    hero.mobile[0] ? heroImageCandidate(hero.mobile[0].url, "mobile", layout) : null,
    hero.desktop[0] ? heroImageCandidate(hero.desktop[0].url, "desktop", layout) : null,
  ].filter((candidate): candidate is HeroImageCandidate => Boolean(candidate?.src));
}

export interface ResolvedHomepageHero {
  desktop: HeroSlide[];
  mobile: HeroSlide[];
}

/**
 * A hero section's slides as each viewport draws them, from the section's
 * own slides and the homepage media: computers show each slide's image;
 * phones its phone image when that resolves (else the same image, cropped
 * around the phone focal point, else the slide's own). A slide whose image
 * did not resolve (deleted, not ready) is left out on both.
 */
export function resolveHomepageHero(
  slides: readonly StorefrontHeroSlide[],
  media: (id: string) => HomepageMediaAsset | null,
): ResolvedHomepageHero {
  const desktop: HeroSlide[] = [];
  const mobile: HeroSlide[] = [];
  slides.forEach((slide, index) => {
    const image = media(slide.image);
    if (!image) return;
    const phoneImage = slide.phoneImage ? media(slide.phoneImage) : null;
    const shared = {
      title: slide.alt,
      heading: slide.heading ?? "",
      supportingText: slide.text ?? "",
      buttonLabel: slide.buttonLabel ?? "",
      link: slide.link ?? "",
    };
    desktop.push({ id: `${index}-${image.id}`, url: image.url, ...shared, focalPoint: slide.focalPoint });
    mobile.push({
      id: `${index}-${(phoneImage ?? image).id}`,
      url: (phoneImage ?? image).url,
      ...shared,
      focalPoint: slide.phoneFocalPoint ?? slide.focalPoint,
    });
  });
  return { desktop, mobile };
}
