/**
 * What a product card shows, computed once for every card variant: prices,
 * the discount in each wording, the photo or its placeholder, the buy action
 * and the facts. Facts come from the listing's `cardFacts` (core
 * catalog/card-facts.ts: brand, key specs, options, sales, pack size,
 * delivery) and render nothing when the data is missing: a card never shows
 * "0 sold", "(0) reviews" or a guessed colour.
 */
import type { Product, ProductCardFacts } from "@/lib/api";
import { formatMoney, getDecimalPlaces } from "@/lib/currency";
import { formatDiscountBadge } from "@/components/product/lib/pricing-engine";
import { getProductImageSrcSet, getProductImageUrl, hasProductImage } from "@/lib/product-media";
import { isUnrenderedMediaOriginal } from "@scalius/shared/media-variants";
import { fromMinor, toMinor } from "@scalius/shared/money";
import type {
  StorefrontCardRenderer,
  StorefrontCardSlot,
  StorefrontImageRatio,
} from "@scalius/shared/storefront-theme";
import { cssNamedColour } from "./css-colours";

/** Facts no reader sends yet (reviews, EMI plans on cards); kept so the slots stay honest. */
export interface ProductCardPendingFacts {
  rating?: { average: number; count: number } | null;
  /** The lowest monthly EMI amount in major units, from the merchant's EMI plans. */
  emiMonthlyFrom?: number | null;
}

export type ProductCardProduct = Product & { secondaryImageUrl?: string | null } & ProductCardPendingFacts;

/** Units sold in 30 days below which a card says nothing (owner decision, 2026-09-25; the API applies it too). */
export const SOLD_COUNT_MIN = 10;
export const KEY_SPECS_MAX = 4;
export const SWATCHES_MAX = 5;

/** Intrinsic `width`/`height` per image ratio token (the box's CSS ratio is the card's look). */
export const CARD_IMAGE_DIMENSIONS = {
  square: { width: 400, height: 400 },
  portrait: { width: 400, height: 533 },
  landscape: { width: 400, height: 300 },
} as const satisfies Record<StorefrontImageRatio, { width: number; height: number }>;

/**
 * The margin around a contained photo, as a share of its box width on each
 * side (Star Tech 204px of 254, Daraz 200 of 250, Chaldal's small photo on a
 * 194px tile, Amazon's grey well). Cover photos fill their box (0). The card
 * CSS draws it (`--pc-inset`) and the image `sizes` shrink by it, so the
 * rendition matches the width actually drawn.
 */
export const CARD_PHOTO_INSET: Readonly<Record<string, number>> = {
  spec: 0.1,
  "tech-rounded": 0.07,
  marketplace: 0.1,
  "quick-add": 0.13,
  detailed: 0.05,
};

export interface ProductCardFactValues {
  brand: string | null;
  keySpecs: string[];
  rating: { average: string; count: number } | null;
  /** Units sold in the last 30 days (10 or more). */
  sold: number | null;
  savings: string | null;
  packSize: string | null;
  /** "Free delivery", or the cheapest rate ("৳60"). */
  delivery: { free: true } | { free: false; fee: string } | null;
  emi: string | null;
  /** The first colour axis's values with a known colour (swatch attribute or CSS named colour). */
  swatches: Array<{ label: string; colour: string }>;
  /** "Options: 4 sizes": the size axis first, else the first axis; null without an axis of two or more. */
  options: { label: string; count: number; noun: string } | null;
}

export interface ProductCardModel {
  name: string;
  href: string;
  soldOut: boolean;
  /** Null when the product has no photo we may show on a card: the card shows the placeholder. */
  image: { src: string; srcset: string | undefined; alt: string } | null;
  /** The placeholder's letter: the name's first character. */
  monogram: string;
  hoverImage: { src: string; srcset: string | undefined } | null;
  price: {
    current: string;
    /** The current price split for superscript layouts: symbol, whole units, fraction (may be ""). */
    parts: { symbol: string; whole: string; fraction: string };
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
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text || null;
}

/** The amount off in minor units (exact integer maths), formatted. */
function amountOff(product: Product, money: (amount: number) => string, currencyCode: string): string | null {
  if (product.priceVaries || !(product.discountedPrice < product.price) || product.discountedPrice < 0) return null;
  const decimals = getDecimalPlaces(currencyCode);
  const saved = toMinor(product.price, decimals) - toMinor(product.discountedPrice, decimals);
  return saved > 0 ? money(fromMinor(saved, decimals)) : null;
}

/** "৳1,36,950.50" as symbol, whole units and fraction for a superscript price. */
export function splitMoney(formatted: string, symbol: string): { symbol: string; whole: string; fraction: string } {
  const negative = formatted.startsWith("-");
  const unsigned = negative ? formatted.slice(1) : formatted;
  const hasSymbol = symbol !== "" && unsigned.startsWith(symbol);
  const digits = hasSymbol ? unsigned.slice(symbol.length) : unsigned;
  const point = digits.lastIndexOf(".");
  return {
    symbol: hasSymbol ? symbol.trim() : "",
    whole: `${negative ? "-" : ""}${point < 0 ? digits : digits.slice(0, point)}`,
    fraction: point < 0 ? "" : digits.slice(point + 1),
  };
}

/** A card photo: never one of our originals (up to 2400px, ~1MB) on a card. */
function cardPhoto(url: string | null | undefined): string | null {
  return hasProductImage(url) && !isUnrenderedMediaOriginal(url) ? url!.trim() : null;
}

/**
 * "Options: 4 sizes", "Options: 3 colours"; any other axis keeps the
 * merchant's name rather than a guessed plural ("Storage: 3 options").
 */
function optionNoun(option: ProductCardFacts["options"][number]): { label: string; count: number; noun: string } {
  if (option.kind === "size") return { label: "Options:", count: option.count, noun: "sizes" };
  if (option.kind === "color") return { label: "Options:", count: option.count, noun: "colours" };
  return { label: `${option.name.trim()}:`, count: option.count, noun: "options" };
}

function cardFactValues(
  facts: ProductCardFacts | undefined,
  product: ProductCardProduct,
  money: (amount: number) => string,
  saved: string | null,
): ProductCardFactValues {
  const rating = product.rating;
  const emi = product.emiMonthlyFrom ?? 0;
  const sold = facts?.soldLast30Days ?? 0;
  const options = facts?.options ?? [];
  const colourAxis = options.find((option) => option.kind === "color");
  const countedAxis = options.find((option) => option.kind === "size") ?? options[0];
  const stored = facts?.delivery ?? null;
  const delivery = product.freeDelivery || stored?.free === true
    ? { free: true as const }
    : stored && stored.free === false && stored.feeFrom > 0
      ? { free: false as const, fee: money(stored.feeFrom) }
      : null;
  return {
    brand: nonEmpty(facts?.brand?.name),
    keySpecs: (facts?.keySpecs ?? [])
      .map((spec) => spec.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, KEY_SPECS_MAX),
    rating: rating && rating.count > 0 && rating.average > 0
      ? { average: (Math.round(Math.min(rating.average, 5) * 10) / 10).toFixed(1), count: rating.count }
      : null,
    sold: sold >= SOLD_COUNT_MIN ? Math.floor(sold) : null,
    savings: saved ? `Save ${saved}` : null,
    packSize: nonEmpty(facts?.packSize),
    delivery,
    emi: emi > 0 ? `EMI from ${money(emi)}/month` : null,
    swatches: (colourAxis?.swatches ?? []).flatMap((swatch) => {
      const label = nonEmpty(swatch.label);
      const colour = swatch.hex && /^#[0-9a-f]{6}$/i.test(swatch.hex) ? swatch.hex : cssNamedColour(label);
      return label && colour ? [{ label, colour }] : [];
    }).slice(0, SWATCHES_MAX),
    options: countedAxis && countedAxis.count >= 2 ? optionNoun(countedAxis) : null,
  };
}

export function productCardModel(
  product: ProductCardProduct,
  options: { currencySymbol: string; currencyCode: string; hoverImage: boolean; quickBuy: boolean },
): ProductCardModel {
  const money = (amount: number) => formatMoney(amount, { symbol: options.currencySymbol, code: options.currencyCode });
  const hasDiscount = product.discountedPrice < product.price;
  const soldOut = product.availableForSale === false;
  const photo = cardPhoto(product.imageUrl);
  const hoverPhoto = photo ? cardPhoto(product.secondaryImageUrl) : null;
  const saved = amountOff(product, money, options.currencyCode);
  const current = money(product.discountedPrice);
  return {
    name: product.name,
    href: `/products/${product.slug}`,
    soldOut,
    image: photo
      ? {
          src: getProductImageUrl(photo, 480),
          srcset: getProductImageSrcSet(photo),
          alt: product.imageAlt || product.name,
        }
      : null,
    monogram: firstCharacter(product.name),
    hoverImage: options.hoverImage && hoverPhoto
      ? {
          src: getProductImageUrl(hoverPhoto, 480),
          srcset: getProductImageSrcSet(hoverPhoto),
        }
      : null,
    price: {
      current,
      parts: splitMoney(current, options.currencySymbol),
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
    facts: cardFactValues(product.cardFacts, product, money, saved),
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
    case "swatches": return facts.swatches.length > 0;
    case "options": return facts.options !== null;
  }
}

/** Amazon's "1K+ bought in past month": rounded down, never above the real count. */
export function boughtInPastMonth(sold: number): string {
  if (sold >= 1000) return `${Math.floor(sold / 1000)}K+`;
  if (sold >= 100) return `${Math.floor(sold / 100) * 100}+`;
  if (sold >= 50) return "50+";
  return `${Math.floor(sold / 10) * 10}+`;
}
