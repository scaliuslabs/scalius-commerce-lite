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

/**
 * Why a theme link is refused (`params.reason`): a save refuses it; a read of a
 * stored one reads it as no link (read-repair.ts), never as a working link.
 */
export const STOREFRONT_INVALID_LINK = "invalid_link";

/** A navigation-safe href, already canonical (`canonicalStorefrontLink(value) === value`). */
export const storefrontLinkSchema = z.string().max(STOREFRONT_LINK_MAX_LENGTH).refine(
  (value) => canonicalStorefrontLink(value) === value,
  { message: "Use a store path such as /collections/new or an https:// link.", params: { reason: STOREFRONT_INVALID_LINK } },
);

/**
 * The store's machinery, never a page a link opens: its API, the app proxy
 * (`/apps/<id>/…`, any app's routes), the app file gateway (`/_x/…`) and
 * every `_` or `~` first segment (build assets, islands, Partytown). Case folded.
 */
export const STOREFRONT_STORE_PATH_RESERVED = /^\/(?:api|apps|[_~][^/]*)(?:\/|$)/i;
const STORE_PATH_SHAPE = /^\/(?!\/)[^\\\s?#]*$/;
export const STOREFRONT_STORE_PATH_MESSAGE = "Link to a page of this store, such as /products/x: no other site, query, /api, /apps or /_ paths.";

/** A page path on this store: no other origin, query, fragment, dot segments, encoded separators or store machinery. */
export function isStorefrontStorePath(path: string): boolean {
  return STORE_PATH_SHAPE.test(path)
    && !path.split("/").some((part) => part === "." || part === "..")
    && !/%(?:2f|5c|2e)/i.test(path)
    && !STOREFRONT_STORE_PATH_RESERVED.test(path);
}

/** The one schema of a page path on this store (a buyer link an app draws, a bottom bar link tab): one refusal, with the caller's reason. */
export function storefrontStorePathSchema(reason: string) {
  const refusal = { message: STOREFRONT_STORE_PATH_MESSAGE, params: { reason } };
  // One check, one issue; the shape still reads as the JSON Schema's pattern.
  return z.string().max(STOREFRONT_LINK_MAX_LENGTH)
    .refine(isStorefrontStorePath, refusal)
    .meta({ pattern: STORE_PATH_SHAPE.source });
}
