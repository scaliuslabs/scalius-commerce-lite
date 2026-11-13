// The [product] shortcode in CMS pages, articles and rich text. Each one
// becomes the listing's own product card, drawn on the server
// (RichContentPieces.astro), so the product is in the HTML a search engine or
// an agent reads; only the card's quick-add runs in the browser. A shortcode
// naming no product draws nothing for buyers and a notice in a theme preview.
// Shortcodes are found in the text the sanitizer writes (renderRichHtml), never
// by cutting its output, so one can never split markup.
import { getApiV1ProductsBySlugs } from "@scalius/api-client/sdk";
import type { ProductCardProduct } from "@/components/cards/card-model";
import { getConfiguredSdkClient } from "@/lib/api/transport";
import { unwrapData } from "@/lib/api/unwrap";
import { MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH } from "@scalius/shared/public-api-cache-routes";
import { sanitizeHtml, type PresentedSlot, type SafeHtml } from "@scalius/shared/html-sanitize";

/** Rich content split at its product shortcodes. */
export type RichContentPiece =
  | { kind: "html"; html: SafeHtml }
  | { kind: "product"; product: ProductCardProduct }
  /** A shortcode whose product does not exist or could not be read: the reference as written. */
  | { kind: "missing"; reference: string };

function normalizeAttributeQuotes(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/** The product a shortcode names (`id` or `slug`), or null when it names none. */
function shortcodeReference(attributesSource: string): string | null {
  const attributes = normalizeAttributeQuotes(attributesSource);
  const values: Record<string, string> = {};
  for (const [, key, value] of attributes.matchAll(/(\w+)=["']([^"']*)["']/g)) {
    if (key && value !== undefined) values[key] = value;
  }
  return values.id || values.slug || null;
}

const PRODUCT_SHORTCODE = /\[product\b([^\]]*)\]/g;
const LONE_SHORTCODE = /^\s*\[product\b([^\]]*)\]\s*$/;

/**
 * Distinct products one document's shortcodes draw: the first this many in
 * the text; a shortcode naming another stays the merchant's text. All of
 * them are one card read (`GET /products/by-slugs`, its bound), split only
 * where the handles outgrow the cached read's query value.
 */
export const SHORTCODE_MAX_PRODUCTS = 50;

/** The products the content's shortcodes name, each once and at most SHORTCODE_MAX_PRODUCTS: read from each text the sanitizer keeps, as the cards are placed. */
export function productShortcodeReferences(content: string): string[] {
  const references = new Set<string>();
  sanitizeHtml(content, {
    present: {
      text(value) {
        if (!value.includes("[product")) return;
        for (const [, attributes] of value.matchAll(PRODUCT_SHORTCODE)) {
          const reference = shortcodeReference(attributes ?? "");
          if (reference && references.size < SHORTCODE_MAX_PRODUCTS) references.add(reference);
        }
      },
    },
  });
  return [...references];
}

/** The handles in reads whose `slugs` value fits the cached read's bound. */
export function shortcodeCardReads(references: readonly string[]): string[] {
  const reads: string[] = [];
  let current = "";
  for (const reference of references) {
    const next = current ? `${current},${reference}` : reference;
    if (current && next.length > MAX_PUBLIC_CACHE_QUERY_VALUE_LENGTH) {
      reads.push(current);
      current = reference;
    } else current = next;
  }
  if (current) reads.push(current);
  // A handle longer than the bound alone is no product's: the read refuses it, and it shows as missing.
  return reads;
}

type ShortcodeCard = ProductCardProduct & { reference: string };

/**
 * The listing card of each named product, from one batched read (it joins
 * the render's batch, so the page's cache proof covers every card); null for
 * one the store does not have, does not sell now, or that could not be read.
 */
export async function readShortcodeProducts(references: readonly string[]): Promise<Map<string, ProductCardProduct | null>> {
  const cards = new Map<string, ProductCardProduct | null>(references.map((reference) => [reference, null]));
  await Promise.all(shortcodeCardReads(references).map(async (slugs) => {
    try {
      const { data, error } = await getApiV1ProductsBySlugs({ client: getConfiguredSdkClient(), query: { slugs } });
      if (error) throw error;
      const products = unwrapData<{ products?: ShortcodeCard[] }>(data)?.products ?? [];
      for (const card of products) if (cards.has(card.reference)) cards.set(card.reference, card);
    } catch (error: unknown) {
      console.error(`Error reading the products of shortcodes "${slugs}":`, error);
    }
  }));
  return cards;
}

/**
 * A text with each shortcode naming a product replaced by the slot `place`
 * gives it; nothing when it has none. A shortcode naming nothing, or one
 * `place` gives no slot (over the product bound), stays the merchant's text.
 */
export function presentProductShortcodes(text: string, place: (reference: string) => PresentedSlot | null): Array<string | PresentedSlot> | void {
  if (!text.includes("[product")) return;
  const parts: Array<string | PresentedSlot> = [];
  let last = 0;
  for (const match of text.matchAll(PRODUCT_SHORTCODE)) {
    const reference = shortcodeReference(match[1] ?? "");
    const slot = reference ? place(reference) : null;
    if (!slot) continue;
    parts.push(text.slice(last, match.index), slot);
    last = match.index + match[0].length;
  }
  if (last === 0) return;
  parts.push(text.slice(last));
  return parts.filter((part) => part !== "");
}

/** A paragraph that holds only a shortcode naming a product: its card replaces the paragraph (a block cannot sit in a paragraph). */
export function isLoneProductShortcode(text: string): boolean {
  const match = LONE_SHORTCODE.exec(text);
  return match !== null && shortcodeReference(match[1] ?? "") !== null;
}

/**
 * Plain text without its shortcodes: a description or excerpt cut from rich
 * content never shows `[product slug="..."]` to a search engine or a reader.
 */
export function withoutShortcodes(text: string): string {
  return text.replace(PRODUCT_SHORTCODE, " ").replace(/\s+/g, " ").trim();
}
