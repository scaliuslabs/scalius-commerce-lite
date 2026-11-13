// The [product] shortcode in CMS pages, articles and rich text. Each one
// becomes the listing's own product card, drawn on the server
// (RichContentPieces.astro), so the product is in the HTML a search engine or
// an agent reads; only the card's quick-add runs in the browser. A shortcode
// naming no product draws nothing for buyers and a notice in a theme preview.
// Shortcodes are found in the text the sanitizer writes (renderRichHtml), never
// by cutting its output, so one can never split markup.
import { getProductBySlug, type ProductPageData } from "@/lib/api";
import type { ProductCardProduct } from "@/components/cards/card-model";
import { quickAddCartLine } from "@/components/cards/scripts/quick-add-card";
import { getBuyerVariantPricePresentation } from "@/components/product/lib/pricing-engine";
import { resolveBuyerVariants, isVariantAvailable } from "@/lib/product-sellable-variants";
import { hasProductImage } from "@/lib/product-media";
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

/**
 * The listing card's projection of a product page read: the lowest buyer
 * price and whether SKUs differ ("From"), the first photos, availability and
 * whether quick-add can add it at once, as the listing read computes them.
 * Facts and ratings are listing-only fields and stay absent, so the card
 * draws none.
 */
export interface ShortcodeCurrency {
  code: string;
  /** The layout's `currency.priceIncrementMinor`: a server render has no page globals. */
  priceIncrementMinor?: number;
}

export function productCardOfPage(data: ProductPageData, currency: ShortcodeCurrency): ProductCardProduct {
  const { product, media, variants } = data;
  const buyerVariants = resolveBuyerVariants(variants).variants;
  const presentation = getBuyerVariantPricePresentation({
    basePrice: product.price,
    discountType: product.discountType,
    discountPercentage: product.discountPercentage,
    discountAmount: product.discountAmount,
    currencyCode: currency.code,
    priceIncrementMinor: currency.priceIncrementMinor,
  }, buyerVariants);
  const photos = media.flatMap((item) => {
    const url = item.kind === "image" ? item.url : item.posterUrl;
    return url && hasProductImage(url) ? [url] : [];
  });
  const imageUrl = product.imageUrl ?? photos[0] ?? null;
  return {
    ...product,
    price: presentation.pricing.originalPrice,
    discountedPrice: presentation.pricing.finalPrice,
    priceVaries: presentation.isStartingAt,
    imageUrl,
    secondaryImageUrl: photos.find((url) => url !== imageUrl) ?? null,
    availableForSale: buyerVariants.length === 0 ? product.availableForSale !== false : buyerVariants.some(isVariantAvailable),
    quickAddEligible: quickAddCartLine(data, currency.code) !== null,
  };
}

const PRODUCT_SHORTCODE = /\[product\b([^\]]*)\]/g;
const LONE_SHORTCODE = /^\s*\[product\b([^\]]*)\]\s*$/;

/**
 * Distinct products one document's shortcodes draw: the first this many in
 * the text; a shortcode naming another stays the merchant's text. Each is one
 * product read inside the render's one batched API call.
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

/**
 * Reads each named product once (the reads join the render's batch, so the
 * page's cache proof covers them); null for one the store does not have or
 * cannot read now.
 */
export async function readShortcodeProducts(references: readonly string[]): Promise<Map<string, ProductPageData | null>> {
  return new Map(await Promise.all(references.map(async (reference) => [reference, await getProductBySlug(reference).catch((error: unknown) => {
    console.error(`Error reading the product of shortcode "${reference}":`, error);
    return null;
  })] as const)));
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
