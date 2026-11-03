// Brand presentation: the logo, its width, the logo for dark pages, the
// footer's own logo and the browser tab icon. They are theme choices (a draft previews them, a publish
// makes them live, a restore brings them back) stored as media ids that the
// API checks on every save. Store identity (name, phone, email, address,
// social profiles) is not here: Settings -> Store owns it.
import { z } from "zod";
import {
  HEADER_LOGO_WIDTH_DEFAULT,
  HEADER_LOGO_WIDTH_MAX,
  HEADER_LOGO_WIDTH_MIN,
  HEADER_LOGO_WIDTH_STEP,
} from "../brand-presentation";

const mediaId = z.string().trim().min(1).max(64);

export const storefrontThemeBrandSchema = z.object({
  /** The header logo (also the checkout header's and the share image's fallback); null: the store name in text. */
  logo: mediaId.nullable(),
  /** The header logo's width on computers in px; phones cap it at 160. */
  logoWidth: z.number().int().min(HEADER_LOGO_WIDTH_MIN).max(HEADER_LOGO_WIDTH_MAX).multipleOf(HEADER_LOGO_WIDTH_STEP),
  /** The logo on dark pages (the theme's dark colours on screen, a light logo); null: the logo everywhere. */
  darkLogo: mediaId.nullable(),
  /** The footer's own logo (a light logo on a dark footer); null: the store name in text. */
  footerLogo: mediaId.nullable(),
  /** The browser tab icon; null: the platform icon. */
  favicon: mediaId.nullable(),
}).strict();
export type StorefrontThemeBrand = z.infer<typeof storefrontThemeBrandSchema>;

export const DEFAULT_STOREFRONT_THEME_BRAND: StorefrontThemeBrand = Object.freeze({
  logo: null,
  logoWidth: HEADER_LOGO_WIDTH_DEFAULT,
  darkLogo: null,
  footerLogo: null,
  favicon: null,
});

/** The brand's images, each a media id or null. */
export const STOREFRONT_BRAND_IMAGE_KEYS = ["logo", "darkLogo", "footerLogo", "favicon"] as const;
export type StorefrontBrandImageKey = (typeof STOREFRONT_BRAND_IMAGE_KEYS)[number];

/** The brand's images by media id, each once. */
export function storefrontThemeBrandMediaIds(brand: StorefrontThemeBrand): string[] {
  return [...new Set(STOREFRONT_BRAND_IMAGE_KEYS.map((key) => brand[key]).filter((id): id is string => Boolean(id)))];
}

/** A brand image as the storefront draws it (a ready or trashed image; never a video). */
export interface StorefrontBrandAsset {
  id: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
}

/** The brand's images resolved: what the layout and a draft preview carry beside the theme. */
export interface StorefrontBrandAssets {
  logo: StorefrontBrandAsset | null;
  darkLogo: StorefrontBrandAsset | null;
  footerLogo: StorefrontBrandAsset | null;
  favicon: StorefrontBrandAsset | null;
}

export const EMPTY_STOREFRONT_BRAND_ASSETS: StorefrontBrandAssets = Object.freeze({ logo: null, darkLogo: null, footerLogo: null, favicon: null });

/** The brand's assets from images looked up by id (missing ones read as null). */
export function storefrontBrandAssets(
  brand: StorefrontThemeBrand,
  images: readonly StorefrontBrandAsset[],
): StorefrontBrandAssets {
  const byId = new Map(images.map((image) => [image.id, image]));
  const pick = (id: string | null) => (id ? byId.get(id) ?? null : null);
  return Object.fromEntries(STOREFRONT_BRAND_IMAGE_KEYS.map((key) => [key, pick(brand[key])])) as unknown as StorefrontBrandAssets;
}
