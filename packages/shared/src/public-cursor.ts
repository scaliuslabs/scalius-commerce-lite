/**
 * Signed continuation tokens of the public discovery reads (catalogue feeds
 * and the product sitemap). The API issues them; it accepts only a token it
 * signed, and refuses any other before it reads the database, so a crawler
 * (or anyone) can follow the advertised continuations but cannot ask for an
 * arbitrary position: every accepted request is one the API itself linked.
 *
 * A token is `<position>.<signature>`: the position the API decodes, then a
 * 43-character base64url HMAC-SHA256 over the position and its scope (the
 * feed's channel, a sitemap page's number and size).
 */

/** A feed continuation: `feed-v2.<created_at base36>.<product id base64url>.<signature>`. */
export const PUBLIC_FEED_CURSOR_PATTERN = /^feed-v2\.[0-9a-z]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** A product sitemap page boundary: `<created_at base36>.<product id base64url>.<signature>`. */
export const SITEMAP_AFTER_PATTERN = /^[0-9a-z]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** The longest token either read accepts. */
export const PUBLIC_CURSOR_MAX_LENGTH = 512;

export function isPublicFeedCursor(value: string): boolean {
  return value.length <= PUBLIC_CURSOR_MAX_LENGTH && PUBLIC_FEED_CURSOR_PATTERN.test(value);
}

export function isSitemapAfterToken(value: string): boolean {
  return value.length <= PUBLIC_CURSOR_MAX_LENGTH && SITEMAP_AFTER_PATTERN.test(value);
}
