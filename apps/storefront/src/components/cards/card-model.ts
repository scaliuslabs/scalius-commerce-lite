/**
 * What a product card shows, computed once for every card variant: prices,
 * the discount in each wording, the photo or its placeholder, the buy action
 * and the optional facts. Facts that later phases add to listing products
 * (brand, key specs, reviews, sold counts, pack size, EMI) are optional here
 * and render nothing until the data exists: a card never shows "0 sold" or
 * "(0) reviews".
 */
import type { Product } from "@/lib/api";
import { formatMoney, getDecimalPlaces } from "@/lib/currency";
import { formatDiscountBadge } from "@/components/product/lib/pricing-engine";
import { getProductImageSrcSet, getProductImageUrl, hasProductImage } from "@/lib/product-media";
import { fromMinor, toMinor } from "@scalius/shared/money";
import type {
  StorefrontCardRenderer,
  StorefrontCardSlot,
  StorefrontImageRatio,
} from "@scalius/shared/storefront-theme";

/** Card facts from later phases (brand entity, key-spec attributes, reviews, sales, EMI plans). */
export interface ProductCardFacts {
  brand?: { name: string } | null;
  keySpecs?: readonly string[] | null;
  rating?: { average: number; count: number } | null;
  /** Units sold; shown only at SOLD_COUNT_MIN or more (owner decision, 2026-09-25). */
  soldCount?: number | null;
  packSize?: string | null;
  /** The lowest monthly EMI amount in major units, from the merchant's EMI plans. */
  emiMonthlyFrom?: number | null;
}

export type ProductCardProduct = Product & { secondaryImageUrl?: string | null } & ProductCardFacts;

export const SOLD_COUNT_MIN = 10;
export const KEY_SPECS_MAX = 4;

/** Intrinsic `width`/`height` per image ratio token (the box's CSS ratio is the token). */
export const CARD_IMAGE_DIMENSIONS = {
  square: { width: 400, height: 400 },
  portrait: { width: 400, height: 533 },
  landscape: { width: 400, height: 300 },
} as const satisfies Record<StorefrontImageRatio, { width: number; height: number }>;

export interface ProductCardFactValues {
  brand: string | null;
  keySpecs: string[];
  rating: { average: string; count: number } | null;
  sold: number | null;
  savings: string | null;
  packSize: string | null;
  delivery: "free" | null;
  emi: string | null;
}

export interface ProductCardModel {
  name: string;
  href: string;
  soldOut: boolean;
  /** Null when the product has no photo: the card shows the placeholder. */
  image: { src: string; srcset: string | undefined; alt: string } | null;
  /** The placeholder's letter: the name's first character. */
  monogram: string;
  hoverImage: { src: string; srcset: string | undefined } | null;
  price: {
    current: string;
    /** The struck regular price, when discounted. */
    regular: string | null;
    prefix: "From " | "";
  };
  /** "-20%", or null without a discount. */
  percentOff: string | null;
  /** The amount saved, formatted; null without a discount or when the price varies by option. */
  amountOff: string | null;
  /** The buy link when the card has a buy action and the product needs no choice. */
  quickBuyHref: string | null;
  /** The product has options, so the card's action is "choose options" on the product page. */
  needsOptions: boolean;
  facts: ProductCardFactValues;
}

function firstCharacter(name: string): string {
  const text = name.trim();
  if (!text) return "";
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text);
  const first = segments[Symbol.iterator]().next().value?.segment ?? "";
  return first.toLocaleUpperCase();
}

function nonEmpty(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

/** The amount off in minor units (exact integer maths), formatted. */
function amountOff(product: Product, money: (amount: number) => string, currencyCode: string): string | null {
  if (product.priceVaries || !(product.discountedPrice < product.price) || product.discountedPrice < 0) return null;
  const decimals = getDecimalPlaces(currencyCode);
  const saved = toMinor(product.price, decimals) - toMinor(product.discountedPrice, decimals);
  return saved > 0 ? money(fromMinor(saved, decimals)) : null;
}

export function productCardModel(
  product: ProductCardProduct,
  options: { currencySymbol: string; currencyCode: string; hoverImage: boolean; quickBuy: boolean },
): ProductCardModel {
  const money = (amount: number) => formatMoney(amount, { symbol: options.currencySymbol, code: options.currencyCode });
  const hasDiscount = product.discountedPrice < product.price;
  const soldOut = product.availableForSale === false;
  const hasImage = hasProductImage(product.imageUrl);
  const saved = amountOff(product, money, options.currencyCode);
  const rating = product.rating;
  const soldCount = product.soldCount ?? 0;
  const emi = product.emiMonthlyFrom ?? 0;
  return {
    name: product.name,
    href: `/products/${product.slug}`,
    soldOut,
    image: hasImage
      ? {
          src: getProductImageUrl(product.imageUrl, 480),
          srcset: getProductImageSrcSet(product.imageUrl),
          alt: product.imageAlt || product.name,
        }
      : null,
    monogram: firstCharacter(product.name),
    hoverImage: options.hoverImage && hasImage && hasProductImage(product.secondaryImageUrl)
      ? {
          src: getProductImageUrl(product.secondaryImageUrl, 480),
          srcset: getProductImageSrcSet(product.secondaryImageUrl),
        }
      : null,
    price: {
      current: money(product.discountedPrice),
      regular: hasDiscount ? money(product.price) : null,
      prefix: product.priceVaries ? "From " : "",
    },
    percentOff: formatDiscountBadge(product.price, product.discountedPrice),
    amountOff: saved,
    // "Buy now" needs no choice from the buyer: in stock and without options.
    quickBuyHref: options.quickBuy && !soldOut && !product.hasVariants
      ? `/buy/${encodeURIComponent(product.slug)}`
      : null,
    needsOptions: !soldOut && product.hasVariants,
    facts: {
      brand: nonEmpty(product.brand?.name),
      keySpecs: (product.keySpecs ?? [])
        .map((spec) => spec.trim())
        .filter(Boolean)
        .slice(0, KEY_SPECS_MAX),
      rating: rating && rating.count > 0 && rating.average > 0
        ? { average: (Math.round(Math.min(rating.average, 5) * 10) / 10).toFixed(1), count: rating.count }
        : null,
      sold: soldCount >= SOLD_COUNT_MIN ? Math.floor(soldCount) : null,
      savings: saved ? `Save ${saved}` : null,
      packSize: nonEmpty(product.packSize),
      delivery: product.freeDelivery ? "free" : null,
      emi: emi > 0 ? `EMI from ${money(emi)}/month` : null,
    },
  };
}

/** The discount as the card words it; amount wordings fall back to the percentage when the price varies. */
export function cardDiscountLabel(
  model: Pick<ProductCardModel, "percentOff" | "amountOff">,
  discount: StorefrontCardRenderer["discount"],
): string | null {
  if (!model.percentOff) return null;
  if (discount === "sale") return "Sale";
  if (discount === "save" && model.amountOff) return `Save ${model.amountOff}`;
  if (discount === "off" && model.amountOff) return `${model.amountOff} OFF`;
  return model.percentOff;
}

/** Whether a fact slot has data to show (empty slots render nothing). */
export function cardFactPresent(facts: ProductCardFactValues, slot: StorefrontCardSlot): boolean {
  switch (slot) {
    case "brand": return facts.brand !== null;
    case "key-specs": return facts.keySpecs.length > 0;
    case "rating": return facts.rating !== null;
    case "sold": return facts.sold !== null;
    case "savings": return facts.savings !== null;
    case "pack-size": return facts.packSize !== null;
    case "delivery": return facts.delivery !== null;
    case "emi": return facts.emi !== null;
  }
}
