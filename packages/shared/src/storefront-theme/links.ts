// Links a theme document carries (an announcement, a hero slide): the same
// rule as navigation menu hrefs (`../navigation-href.ts`), stored in its
// canonical form so the storefront renders exactly what was saved. Same-store
// paths, `?query` and `#fragment` targets, or an absolute https:// URL; no
// protocol-relative, credential-bearing, whitespace or traversal targets.
import { z } from "zod";
import { parseNavigationHref } from "../navigation-href";

export const STOREFRONT_LINK_MAX_LENGTH = 2_048;

/** A link's canonical form, or null when it is not a usable link (empty text included). */
export function canonicalStorefrontLink(value: unknown): string | null {
  const parsed = parseNavigationHref(value);
  return parsed.ok && parsed.kind !== "label" && parsed.href ? parsed.href : null;
}

/** A navigation-safe href, already canonical (`canonicalStorefrontLink(value) === value`). */
export const storefrontLinkSchema = z.string().max(STOREFRONT_LINK_MAX_LENGTH).refine(
  (value) => canonicalStorefrontLink(value) === value,
  "Use a store path such as /collections/new or an https:// link.",
);
