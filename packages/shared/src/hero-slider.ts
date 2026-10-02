// How a hero slide is drawn. The slides themselves live in the theme
// document's hero section (`storefrontHeroSlideSchema` in
// ./storefront-theme/sections.ts); this file holds the presentation the
// storefront and the dashboard's crop previews share.
import {
  STOREFRONT_DEFAULT_FOCAL_POINT,
  type StorefrontFocalPoint,
} from "./storefront-theme/sections";

/** The authored banner sizes per viewport: computers and phones. */
export const HERO_SLIDE_PRESENTATION = {
  desktop: { width: 1_300, height: 500 },
  mobile: { width: 640, height: 300 },
} as const;

export type HeroSlideViewport = keyof typeof HERO_SLIDE_PRESENTATION;

/** A focal point: percentages of the image's width (`x`) and height (`y`). */
export type HeroSlideFocalPoint = StorefrontFocalPoint;

export const HERO_SLIDE_DEFAULT_FOCAL_POINT: Readonly<HeroSlideFocalPoint> = STOREFRONT_DEFAULT_FOCAL_POINT;

/**
 * One slide as the storefront draws it on one viewport: the image for that
 * viewport (a phone slide uses its phone image when it has one) and the
 * focal point that goes with it.
 */
export interface HeroSlide {
  id: string;
  url: string;
  /** The image's alt text (what it shows); never drawn over the banner. */
  title: string;
  /** Optional words drawn over the banner; empty for artwork that has its own text. */
  heading: string;
  /** Optional supporting sentence. */
  supportingText: string;
  /** Optional button over the banner; shown only with a link. */
  buttonLabel: string;
  /** The slide's link; empty: not a link. */
  link: string;
  focalPoint: HeroSlideFocalPoint;
}

/** CSS `object-position` that keeps the merchant focal point in an object-fit: cover crop. */
export function getHeroSlideObjectPosition(focalPoint: HeroSlideFocalPoint): string {
  return `${focalPoint.x}% ${focalPoint.y}%`;
}
