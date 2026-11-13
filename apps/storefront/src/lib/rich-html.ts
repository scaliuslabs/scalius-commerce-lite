// The one way the storefront renders merchant rich text (descriptions, pages,
// articles, content blocks): sanitizeHtml writes it, presenting images at
// their renditions, links under the prefetch policy, H1s as H2s where the page
// has its own, and each product shortcode as a slot the page fills with the
// listing's product card (RichContentPieces.astro). Its pieces are the only
// rich text a page inserts (scripts/check-source-policies.mjs).
import { sanitizeHtml, splitSanitizedSlots } from "@scalius/shared/html-sanitize";
import { getStorefrontPrefetchAttribute } from "./prefetch-policy";
import { mediaImageUrl } from "./media-url";
import { presentRichContentImage, presentRichContentSource, shouldSkipImage } from "./rich-content-media";
import {
  isLoneProductShortcode,
  presentProductShortcodes,
  productShortcodeReferences,
  readShortcodeProducts,
  type RichContentPiece,
} from "./shortcodes";

export interface RichHtmlOptions {
  /** The page it renders on: a link to a private page is not prefetched. */
  page?: URL;
  /** The page has its own H1: the text's H1s become H2s. */
  demoteH1?: boolean;
  /** The text opens the page: its first image loads eagerly at a larger size. */
  priorityImage?: boolean;
  /** Draw `[product …]` shortcodes as the listing's product cards (one card read for the document). */
  shortcodes?: boolean;
}

export async function renderRichHtml(content: string | null | undefined, options: RichHtmlOptions = {}): Promise<RichContentPiece[]> {
  if (!content) return [];
  const references = options.shortcodes && content.includes("[product") ? productShortcodeReferences(content) : [];
  const products = references.length > 0 ? await readShortcodeProducts(references) : new Map<string, never>();
  const slots: RichContentPiece[] = [];
  let images = 0;
  const html = sanitizeHtml(content, {
    present: {
      element(tag, attributes, shortText) {
        if (tag === "a") {
          if (getStorefrontPrefetchAttribute(attributes.get("href"), options.page)) attributes.set("data-astro-prefetch", "false");
        } else if (tag === "img") {
          if (presentRichContentImage(attributes, options.priorityImage === true && images === 0)) images += 1;
        } else if (tag === "source") {
          presentRichContentSource(attributes);
        } else if (tag === "h1" && options.demoteH1) {
          return "h2";
        } else if (tag === "p" && products.size > 0 && isLoneProductShortcode(shortText() ?? "")) {
          return "unwrap";
        }
      },
      text: products.size > 0 ? (value) => presentProductShortcodes(value, (reference) => {
        if (!products.has(reference)) return null; // over SHORTCODE_MAX_PRODUCTS: left as written
        const product = products.get(reference);
        slots.push(product ? { kind: "product", product } : { kind: "missing", reference });
        return { slot: slots.length - 1 };
      }) : undefined,
    },
  });
  return splitSanitizedSlots(html).map((part) => (typeof part === "number" ? slots[part]! : { kind: "html", html: part }));
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
