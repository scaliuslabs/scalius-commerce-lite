/**
 * Brand record rules (migration 0088 `brands`). A brand has its own page at
 * `/brands/<slug>`, an optional logo from the media library and the same SEO
 * fields as a category. Slugs follow the product handle pattern; short brand
 * names such as "HP" or "LG" are allowed, so the minimum is one character.
 */
import { z } from "zod";
import { HANDLE_MAX_LENGTH, HANDLE_PATTERN } from "./handle";

export const BRAND_ID_PREFIX = "brd_";
export const BRAND_STATUSES = ["draft", "published"] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

export const BRAND_NAME_MAX_LENGTH = 120;
export const BRAND_DESCRIPTION_MAX_LENGTH = 20_000;

export const brandNameSchema = z.string().trim().min(1).max(BRAND_NAME_MAX_LENGTH);
export const brandSlugSchema = z
  .string()
  .min(1)
  .max(HANDLE_MAX_LENGTH)
  .regex(HANDLE_PATTERN, "Use lowercase letters, numbers and single dashes.");

/** True for an id this schema accepts (`brd_` plus 6-64 URL-safe characters). */
export function isBrandId(value: string): boolean {
  return /^brd_[A-Za-z0-9_-]{6,64}$/.test(value);
}
