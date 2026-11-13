// The one way the storefront renders merchant rich text (descriptions, pages,
// articles, content blocks): sanitizeHtml writes it, presenting images at
// their renditions, links under the prefetch policy, H1s as H2s where the page
// has its own, and shortcodes as product cards. Its SafeHtml is the only rich
// text a page passes to `set:html` (scripts/check-source-policies.mjs).
import { sanitizeHtml, type SafeHtml } from "@scalius/shared/html-sanitize";
import { getStorefrontPrefetchAttribute } from "./prefetch-policy";
import { mediaImageUrl } from "./media-url";
import { presentRichContentImage, presentRichContentSource, shouldSkipImage } from "./rich-content-media";
import { isLoneProductShortcode, presentProductShortcodes, resolveProductShortcodes } from "./shortcodes";

export interface RichHtmlOptions {
  /** The page it renders on: a link to a private page is not prefetched. */
  page?: URL;
  /** The page has its own H1: the text's H1s become H2s. */
  demoteH1?: boolean;
  /** The text opens the page: its first image loads eagerly at a larger size. */
  priorityImage?: boolean;
  /** Draw `[product …]` shortcodes as product cards. */
  shortcodes?: boolean;
}

export async function renderRichHtml(content: string | null | undefined, options: RichHtmlOptions = {}): Promise<SafeHtml> {
  if (!content) return sanitizeHtml("");
  const cards = options.shortcodes && content.includes("[product") ? await resolveProductShortcodes(content) : null;
  let images = 0;
  return sanitizeHtml(content, {
    present: {
      element(tag, attributes, text) {
        if (tag === "a") {
          if (getStorefrontPrefetchAttribute(attributes.get("href"), options.page)) attributes.set("data-astro-prefetch", "false");
        } else if (tag === "img") {
          if (presentRichContentImage(attributes, options.priorityImage === true && images === 0)) images += 1;
        } else if (tag === "source") {
          presentRichContentSource(attributes);
        } else if (tag === "h1" && options.demoteH1) {
          return "h2";
        } else if (tag === "p" && cards?.size && isLoneProductShortcode(text())) {
          return "unwrap";
        }
      },
      text: cards?.size ? (value) => presentProductShortcodes(value, cards) : undefined,
    },
  });
}

const STANDALONE_SHORTCODE_PATTERN = /^\s*(?:<p(?:\s[^>]*)?>\s*)?\[product\b[^\]]+\]\s*(?:<\/p>)?\s*$/i;

/** Content that is one shortcode and nothing else: the page draws the card full width. */
export function isStandaloneShortcodeContent(content: string | null | undefined): boolean {
  return STANDALONE_SHORTCODE_PATTERN.test(sanitizeHtml(content));
}

const IMG_TAG_RE = /<img\b([^>]*)>/gi;
/** In sanitized HTML every value is double-quoted and holds no `"`, `<` or `>`. */
const SRC_ATTR_RE = /\ssrc="([^"]*)"/;

/**
 * The first image in rich text at a share-sized rendition: the share image
 * (og:image, BlogPosting image) of content without its own featured image.
 */
export function firstRichContentImageUrl(content: string | null | undefined, width: number): string | null {
  for (const [, attributes] of sanitizeHtml(content).matchAll(IMG_TAG_RE)) {
    const src = (attributes?.match(SRC_ATTR_RE)?.[1] ?? "").replace(/&amp;/g, "&").trim();
    if (!shouldSkipImage(src)) return mediaImageUrl(src, width) || null;
  }
  return null;
}
