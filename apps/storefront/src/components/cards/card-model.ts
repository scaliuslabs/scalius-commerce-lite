/**
 * What the product card shows, computed once: the prices, the discount
 * badge, the photo or its placeholder, the buy action and the facts. Facts
 * come from the listing's `cardFacts` (core catalog/card-facts.ts: key
 * specs, options, pack size, delivery) and render nothing when the data is
 * missing: a card never shows "(0) reviews" or a guessed colour.
 */
import type { Product } from "@/lib/api";
import { formatMoney } from "@/lib/currency";
import { formatDiscountBadge } from "@/components/product/lib/pricing-engine";
import { getProductImageSrcSet, getProductImageUrl, hasProductImage, resolveProductImageUrl } from "@/lib/product-media";
import { isUnrenderedMediaOriginal } from "@scalius/shared/media-variants";
import { capImageSrcSet } from "@/lib/responsive-image";
import type { ProductCondition } from "@scalius/shared/product-condition";
import { storefrontCopy, storefrontLanguage } from "@/lib/storefront-copy";
import { pageLanguage } from "@/lib/store-time-zone";
import type { StorefrontImageRatio } from "@scalius/shared/storefront-theme";
import { cssNamedColour } from "./css-colours";

export type ProductCardProduct = Product & { secondaryImageUrl?: string | null };

/** Key specs a card lists (two on phones, three from 640px). */
export const KEY_SPECS_MAX = 3;
/** Colour swatches a card draws before "+N". */
export const SWATCHES_MAX = 5;

/** Intrinsic `width`/`height` per image ratio token (the box's CSS ratio). */
export const CARD_IMAGE_DIMENSIONS = {
  square: { width: 400, height: 400 },
  portrait: { width: 400, height: 533 },
  landscape: { width: 400, height: 300 },
} as const satisfies Record<StorefrontImageRatio, { width: number; height: number }>;

export interface ProductCardFactValues {
  keySpecs: string[];
  /** The average (0-5) and the count of published reviews. */
  rating: { average: number; count: number } | null;
  packSize: string | null;
  /** "Free delivery", or the cheapest rate ("৳60"). */
  delivery: { free: true } | { free: false; fee: string } | null;
  /** The colour axis's values with a known colour (swatch value or CSS named colour), and how many more it has. */
  swatches: { items: Array<{ label: string; colour: string }>; more: number };
}

export interface ProductCardModel {
  name: string;
  condition: string | null;
  href: string;
  soldOut: boolean;
  /** Null when the product has no photo we may show on a card: the card shows the placeholder. */
  image: { src: string; srcset: string | undefined; alt: string } | null;
  /** The placeholder's letter: the name's first character. */
  monogram: string;
  /**
   * The hover photo's CDN URL and the card's `srcset` cap: the card names it
   * once and its intent script derives the same `src` (480px) and capped
   * `srcset` the photo has (hoverImageSources).
   */
  hoverImage: { url: string; maxWidth: number | undefined } | null;
  price: {
    current: string;
    /** The struck regular price, when discounted. */
    regular: string | null;
    /** The price varies by option ("From ৳2,450"). */
    from: boolean;
  };
  /** "-20%", or null without a discount. */
  percentOff: string | null;
  /** The product can be added from the card: in stock, a simple product, no buyer inputs, a real price. */
  quickAddEligible: boolean;
  /** The product has options, so the card's action is "Choose options" on the product page. */
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

/** A card photo: never one of our originals (up to 2400px, ~1MB) on a card. */
function cardPhoto(url: string | null | undefined): string | null {
  return hasProductImage(url) && !isUnrenderedMediaOriginal(url) ? url!.trim() : null;
}

function cardFactValues(product: ProductCardProduct, money: (amount: number) => string, ratings: boolean): ProductCardFactValues {
  const facts = product.cardFacts;
  const rating = ratings ? product.rating : null;
  const colourAxis = (facts?.options ?? []).find((option) => option.kind === "color");
  const stored = facts?.delivery ?? null;
  const delivery = product.freeDelivery || stored?.free === true
    ? { free: true as const }
    : stored && stored.free === false && stored.feeFrom > 0
      ? { free: false as const, fee: money(stored.feeFrom) }
      : null;
  const known = (colourAxis?.swatches ?? []).flatMap((swatch) => {
    const label = nonEmpty(swatch.label);
    const colour = swatch.hex && /^#[0-9a-f]{6}$/i.test(swatch.hex) ? swatch.hex : cssNamedColour(label);
    return label && colour ? [{ label, colour }] : [];
  });
  const items = known.slice(0, SWATCHES_MAX);
  return {
    keySpecs: (facts?.keySpecs ?? [])
      .map((spec) => spec.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, KEY_SPECS_MAX),
    rating: rating && rating.count > 0 && rating.average > 0 ? { average: rating.average, count: rating.count } : null,
    packSize: nonEmpty(facts?.packSize),
    delivery,
    // "+N" counts every other colour, those without a known colour included.
    swatches: { items, more: items.length > 0 ? Math.max(0, (colourAxis?.count ?? items.length) - items.length) : 0 },
  };
}

/**
 * Whether a card states the product's condition: only a used or refurbished
 * one. "New" is the default of every new product, and on a card it reads as
 * a new-arrival badge.
 */
export function cardCondition(condition: ProductCondition | null | undefined): condition is "used" | "refurbished" {
  return condition === "used" || condition === "refurbished";
}

export function productCardModel(
  product: ProductCardProduct,
  options: {
    currencySymbol: string;
    currencyCode: string;
    hoverImage: boolean;
    /** Largest rendered image width at the supported screen densities. */
    imageMaxWidth?: number;
    /** False while the store has no published review or reviews are off (`hasReviews`): no card shows a rating. */
    ratings?: boolean;
  },
): ProductCardModel {
  const money = (amount: number) => formatMoney(amount, { symbol: options.currencySymbol, code: options.currencyCode });
  const hasDiscount = product.discountedPrice < product.price;
  const soldOut = product.availableForSale === false;
  const photo = cardPhoto(product.imageUrl);
  const hoverPhoto = photo ? cardPhoto(product.secondaryImageUrl) : null;
  const quickAddEligible = product.quickAddEligible === true && !soldOut && !product.hasVariants &&
    product.priceVaries !== true && product.discountedPrice > 0 &&
    !product.isGiftCard && !product.requiresCustomization && !product.customizationUnavailable &&
    (product.customization?.fields.length ?? 0) === 0;
  return {
    name: product.name,
    condition: cardCondition(product.productCondition) ? storefrontCopy(storefrontLanguage(pageLanguage())).card.condition[product.productCondition!] : null,
    href: `/products/${product.slug}`,
    soldOut,
    image: photo
      ? {
          src: getProductImageUrl(photo, 480),
          srcset: options.imageMaxWidth
            ? capImageSrcSet(getProductImageSrcSet(photo), options.imageMaxWidth)
            : getProductImageSrcSet(photo),
          alt: product.imageAlt || product.name,
        }
      : null,
    monogram: firstCharacter(product.name),
    hoverImage: options.hoverImage && hoverPhoto
      ? { url: resolveProductImageUrl(hoverPhoto), maxWidth: options.imageMaxWidth }
      : null,
    price: {
      current: money(product.discountedPrice),
      regular: hasDiscount ? money(product.price) : null,
      from: product.priceVaries === true,
    },
    percentOff: formatDiscountBadge(product.price, product.discountedPrice),
    quickAddEligible,
    needsOptions: !soldOut && product.hasVariants,
    facts: cardFactValues(product, money, options.ratings !== false),
  };
}
