// The [product] shortcode in CMS pages, articles and rich text. Each one
// becomes the listing's own product card, drawn on the server
// (RichContentPieces.astro), so the product is in the HTML a search engine or
// an agent reads; only the card's quick-add runs in the browser. A shortcode
// naming no product draws nothing for buyers and a notice in a theme preview.
import { getProductBySlug, type ProductPageData } from "@/lib/api";
import type { ProductCardProduct } from "@/components/cards/card-model";
import { quickAddCartLine } from "@/components/cards/scripts/quick-add-card";
import { getBuyerVariantPricePresentation } from "@/components/product/lib/pricing-engine";
import { resolveBuyerVariants, isVariantAvailable } from "@/lib/product-sellable-variants";
import { hasProductImage } from "@/lib/product-media";
import { unwrapParagraphWrappedShortcodes } from "./shortcode-content";

/** Rich content split at its product shortcodes. */
export type RichContentPiece =
  | { kind: "html"; html: string }
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

/**
 * Splits rich content at its product shortcodes and reads each named product
 * once (the reads join the render's batch, so the page's cache proof covers
 * them). Run it last, on the HTML every other rich-content step has already
 * rewritten: the pieces between shortcodes are emitted as they are.
 */
export async function expandShortcodes(content: string, currency: ShortcodeCurrency): Promise<RichContentPiece[]> {
  const html = unwrapParagraphWrappedShortcodes(content);
  const matches = [...html.matchAll(PRODUCT_SHORTCODE)];
  if (matches.length === 0) return html ? [{ kind: "html", html }] : [];

  const reads = new Map<string, Promise<ProductPageData | null>>();
  for (const match of matches) {
    const reference = shortcodeReference(match[1] ?? "");
    if (reference && !reads.has(reference)) {
      reads.set(reference, getProductBySlug(reference).catch((error: unknown) => {
        console.error(`Error reading the product of shortcode "${reference}":`, error);
        return null;
      }));
    }
  }
  const products = new Map(await Promise.all(
    [...reads].map(async ([reference, read]) => [reference, await read] as const),
  ));

  const pieces: RichContentPiece[] = [];
  let cursor = 0;
  for (const match of matches) {
    const before = html.slice(cursor, match.index);
    if (before) pieces.push({ kind: "html", html: before });
    cursor = match.index + match[0].length;
    const reference = shortcodeReference(match[1] ?? "");
    // A shortcode naming nothing stays the merchant's text.
    if (!reference) {
      pieces.push({ kind: "html", html: match[0] });
      continue;
    }
    const data = products.get(reference);
    pieces.push(data
      ? { kind: "product", product: productCardOfPage(data, currency) }
      : { kind: "missing", reference });
  }
  const rest = html.slice(cursor);
  if (rest) pieces.push({ kind: "html", html: rest });
  return pieces;
}
