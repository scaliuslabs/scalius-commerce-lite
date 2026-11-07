/**
 * The URL keys of listing filters: attribute slugs, their range bounds and
 * merchant option axes (`option.<axis>`). Plain constants with no runtime
 * imports, so a buyer page parsing its filters never downloads the attribute
 * schemas (`catalog-attributes.ts`, zod) that re-export them.
 */

/** URL/facet key prefix for merchant option axes; matches the storefront `option.<axis>` filters. */
export const OPTION_FACET_KEY_PREFIX = "option.";

/**
 * The longest name a listing filter key carries: an attribute slug, or the
 * axis of `option.<axis>`. One length for the storefront's URL parsing, the
 * API's query allowlist and the filter resolution, so a key one of them
 * reads is never one another refuses.
 */
export const FACET_FILTER_KEY_MAX_LENGTH = 120;
const FACET_SLUG = `[a-z0-9][a-z0-9-]{0,${FACET_FILTER_KEY_MAX_LENGTH - 1}}`;
const FACET_OPTION = `option\\.[^\\s&=#?]{1,${FACET_FILTER_KEY_MAX_LENGTH}}`;
/** An attribute slug or `option.<axis>` filter key. */
export const FACET_FILTER_KEY_PATTERN = new RegExp(`^(?:${FACET_SLUG}|${FACET_OPTION})$`);
/** One bound of a range facet: `<attribute slug>.min` or `.max`. */
export const FACET_RANGE_KEY_PATTERN = new RegExp(`^(${FACET_SLUG})\\.(min|max)$`);
/** Any filter key a listing reads: a slug, its range bound, or `option.<axis>` (`brand` is a slug). */
export const LISTING_FILTER_KEY_PATTERN = new RegExp(`^(?:${FACET_SLUG}(?:\\.(?:min|max))?|${FACET_OPTION})$`);
