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

/**
 * The store's machinery, never a page a link opens: its API, the app proxy
 * (`/apps/<id>/…`, any app's routes), the app file gateway (`/_x/…`) and
 * every `_` or `~` first segment (build assets, islands, Partytown). Case folded.
 */
export const STOREFRONT_STORE_PATH_RESERVED = /^\/(?:api|apps|[_~][^/]*)(?:\/|$)/i;
const STORE_PATH_SHAPE = /^\/(?!\/)[^\\\s?#]*$/;
export const STOREFRONT_STORE_PATH_MESSAGE = "Link to a page of this store, such as /products/x: no other site, query, /api, /apps or /_ paths.";

/**
 * Escapes a store page path never needs: a letter, digit or `-._~` (`/%61pps`
 * is `/apps` to the router) and a separator (`%2F`, `%5C`).
 */
const NEEDLESS_ESCAPE = /%(?:[46][1-9a-f]|[57][0-9a]|3[0-9]|2d|2e|5f|7e|2f|5c)/i;
/** An escape left after one decoding (`%2561` decodes to `%61`): a path the router could read once more. */
const ESCAPE_AFTER_DECODING = /%[0-9a-f]{2}/i;

/**
 * A page path on this store, as written and as the router reads it decoded:
 * no other origin, query, fragment, dot segments, needless escapes, escapes a
 * second decoding would read (`%2561pps`), malformed escapes or store
 * machinery. A percent sign a path names stays (`/pages/50%25-off`). A pure
 * predicate: it never throws.
 */
export function isStorefrontStorePath(path: string): boolean {
  if (!STORE_PATH_SHAPE.test(path) || NEEDLESS_ESCAPE.test(path)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  if (ESCAPE_AFTER_DECODING.test(decoded)) return false;
  return [path, decoded].every((each) => !each.split("/").some((part) => part === "." || part === "..") && !STOREFRONT_STORE_PATH_RESERVED.test(each));
}

/** The one schema of a page path on this store (a buyer link an app draws, a bottom bar link tab): one refusal, with the caller's reason. */
export function storefrontStorePathSchema(reason: string) {
  const refusal = { message: STOREFRONT_STORE_PATH_MESSAGE, params: { reason } };
  // One check, one issue; the shape still reads as the JSON Schema's pattern.
  return z.string().max(STOREFRONT_LINK_MAX_LENGTH)
    .refine(isStorefrontStorePath, refusal)
    .meta({ pattern: STORE_PATH_SHAPE.source });
}
