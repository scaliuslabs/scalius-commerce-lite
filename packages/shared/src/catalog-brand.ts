/**
 * Brand record rules (migration 0090 `brands`). A brand has its own page at
 * `/brands/<slug>`, an optional logo from the media library and the same SEO
 * fields as a category. Plain values only: the write schemas over them are
 * @scalius/core/modules/brands/browser (brands.validation.ts), so a screen that
 * reads a brand limit never loads zod.
 */

export const BRAND_ID_PREFIX = "brd_";
export const BRAND_STATUSES = ["draft", "published"] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export const BRAND_NAME_MAX_LENGTH = 120;
export const BRAND_DESCRIPTION_MAX_LENGTH = 20_000;

/** True for an id this schema accepts (`brd_` plus 6-64 URL-safe characters). */
export function isBrandId(value: string): boolean {
  return /^brd_[A-Za-z0-9_-]{6,64}$/.test(value);
}
