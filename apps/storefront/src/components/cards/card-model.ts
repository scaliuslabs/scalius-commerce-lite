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
import { getProductImageSrcSet, getProductImageUrl, hasProductImage, resolveProductImageUrl } from "@/lib/product-media";
import { isUnrenderedMediaOriginal, MEDIA_VARIANT_WIDTHS } from "@scalius/shared/media-variants";
import {
  CARD_SIZES_COLLAPSE_FROM_PX,
  capImageSrcSet,
  capPhoneSizesDensity,
  collapseWideSizes,
  scaleSizes,
} from "@/lib/responsive-image";
import { fromMinor, toMinor } from "@scalius/shared/money";
import { PRODUCT_CONDITION_LABELS } from "@scalius/shared/product-condition";
import type {
  ResolvedStorefrontCard,
  StorefrontCardRenderer,
  StorefrontCardSlot,
  StorefrontImageRatio,
} from "@scalius/shared/storefront-theme";
import { cssNamedColour } from "./css-colours";

/** Facts no reader sends yet (EMI plans on cards); kept so the slot stays honest. */
export interface ProductCardPendingFacts {
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

/**
 * Photos drawn at a fixed CSS width however wide their tile grows (the
 * department mall's 170px photo). The card CSS caps the photo at it
 * (`--pc-photo-max`) and the image `sizes` name it, so the rendition always
 * matches the width actually drawn.
 */
export const CARD_PHOTO_MAX_PX: Readonly<Record<string, number>> = {
  mall: 170,
};

/**
 * The image `sizes` of a card's photo in a slot of `slotSizes`: the standard
 * card keeps the slot as it was; every other card names its fixed photo
 * width, or the slot shrunk by its photo margin with its desktop steps
 * merged (at most one rendition step over, never under), and caps DPR-3
 * phones at about 2x the drawn width. The string repeats on every card of
 * a listing, so it stays short.
 */
export function cardPhotoSizes(variant: string, slotSizes: string): string {
  if (variant === "standard") return slotSizes;
  const maxPx = CARD_PHOTO_MAX_PX[variant];
  return capPhoneSizesDensity(maxPx
    ? `${maxPx}px`
    : collapseWideSizes(scaleSizes(slotSizes, 1 - 2 * (CARD_PHOTO_INSET[variant] ?? 0)), MEDIA_VARIANT_WIDTHS, CARD_SIZES_COLLAPSE_FROM_PX));
}

const finite = (value: number) => (Number.isFinite(value) ? String(Number(value)) : "0");

/**
 * Every card but standard: its own look as custom properties (photo ratio,
 * fit, radius and margin, the fixed photo width, title and price type),
 * which theme-cards.css draws with. One store renders one card variant, so
 * the Layout writes them once into the page's token block instead of every
 * card repeating them in a `style` attribute. Built from the registry's
 * numbers and enums only.
 */
export function cardLookTokens(variant: string, anatomy: ResolvedStorefrontCard): Array<[string, string]> {
  if (variant === "standard") return [];
  const { look } = anatomy;
  const photoMaxPx = CARD_PHOTO_MAX_PX[variant];
  const tokens: Array<[string, string]> = [
    ["pc-ratio", finite(look.image.ratio)],
    ["pc-fit", /^[a-z-]+$/.test(look.image.fit) ? look.image.fit : "cover"],
    ["pc-radius", `${finite(look.radius)}px`],
    ["pc-inset", `${Number(((CARD_PHOTO_INSET[variant] ?? 0) * 100).toFixed(2))}%`],
  ];
  if (photoMaxPx !== undefined) tokens.push(["pc-photo-max", `${finite(photoMaxPx)}px`]);
  if (look.title) {
    tokens.push(["pc-title-d", `${finite(look.title.size.desktop)}px`], ["pc-title-m", `${finite(look.title.size.phone)}px`], ["pc-title-w", finite(look.title.weight)]);
  }
  if (look.price) {
    tokens.push(["pc-price-d", `${finite(look.price.size.desktop)}px`], ["pc-price-m", `${finite(look.price.size.phone)}px`], ["pc-price-w", finite(look.price.weight)]);
  }
  return tokens;
}

/**
 * The cards' line icons (24px grid, stroked in the text colour). A card
 * draws one with `<svg><use href="#pci-…"/></svg>`; the Layout writes the
 * symbols its store's card uses once per page (CardIconSprite.astro), so a
 * listing does not repeat the same paths on every card. The stroke of each
 * is its own (the spec card's 2px, the round buttons' 2.25px).
 */
export const CARD_ICONS = {
  "pci-cart": { d: "M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 1.9-1.4L21 8H6.2M9.5 20.5h.01M17.5 20.5h.01", width: 2, join: true },
  "pci-compare": { d: "M4 6h10M4 12h16M4 18h10M18 4v4M16 6h4", width: 2, join: true },
  "pci-cart-round": { d: "M3 4h2l2.4 10.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 1.9-1.4L21 8H6.2M9.5 20.5h.01M17.5 20.5h.01", width: 2.25, join: false },
  "pci-plus": { d: "M12 5v14M5 12h14", width: 2.25, join: false },
  "pci-arrow": { d: "M5 12h14m-6-6 6 6-6 6", width: 2.25, join: false },
  "pci-tag": { d: "M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4zM7.5 7.5h.01", width: 2.25, join: true },
} as const;
export type CardIconId = keyof typeof CARD_ICONS;

/** The icons a store's card can draw (empty for the standard card). */
export function cardIconIds(variant: string, anatomy: ResolvedStorefrontCard): CardIconId[] {
  if (variant === "standard") return [];
  const ids = new Set<CardIconId>();
  if (anatomy.quickBuy && anatomy.action === "round") {
    // Fashion Value's round button is a cart (its hint is words); the others
    // add (+) or open the product page (an arrow).
    if (variant === "fashion-value") ids.add("pci-cart-round");
    else ids.add("pci-plus").add("pci-arrow");
  }
  if (variant === "fashion-value") ids.add("pci-tag");
  if (variant === "spec") ids.add("pci-cart");
  if (anatomy.compare) ids.add("pci-compare");
  return [...ids];
}

/**
 * Store-wide card flags theme-cards.css selects on, as attributes of the
 * page's `.site-root` (the body): the photo's fit, Target's quick-retail
 * card and Chaldal's full-width essentials action.
 */
export function cardPageAttributes(variant: string, anatomy: ResolvedStorefrontCard): Record<string, string> {
  if (variant === "standard") return {};
  return {
    "data-card-fit": anatomy.look.image.fit,
    ...(variant === "retail" && anatomy.action === "outline" ? { "data-card-quick-retail": "" } : {}),
    ...(variant === "quick-add" && anatomy.action === "outline" ? { "data-card-full-essentials": "" } : {}),
  };
}

export interface ProductCardFactValues {
  brand: string | null;
  keySpecs: string[];
  /** The average to one decimal, the stars' filled share (0-100) and the count as a card shows it ("1.2K"). */
  rating: { average: string; count: number; stars: number; countLabel: string } | null;
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
   * `srcset` the photo has (hoverImageSources), instead of every card
   * carrying a second rendition list in the HTML.
   */
  hoverImage: { url: string; maxWidth: number | undefined } | null;
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
  /** True only when the card projection explicitly proves a simple product needs no buyer inputs. */
  quickAddEligible: boolean;
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

/** "118.8K" above a thousand reviews (Amazon), the plain count below. */
export function compactCount(count: number): string {
  const whole = Math.floor(count);
  if (whole < 1000) return String(whole);
  if (whole < 1_000_000) return `${Math.floor(whole / 100) / 10}K`;
  return `${Math.floor(whole / 100_000) / 10}M`;
}

function cardRating(average: number, count: number): NonNullable<ProductCardFactValues["rating"]> {
  const rounded = Math.round(Math.min(average, 5) * 10) / 10;
  return {
    average: rounded.toFixed(1),
    count: Math.floor(count),
    stars: Math.round((rounded / 5) * 1000) / 10,
    countLabel: compactCount(count),
  };
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
    rating: rating && rating.count > 0 && rating.average > 0 ? cardRating(rating.average, rating.count) : null,
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
  options: {
    currencySymbol: string;
    currencyCode: string;
    hoverImage: boolean;
    quickBuy: boolean;
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
  const saved = amountOff(product, money, options.currencyCode);
  const current = money(product.discountedPrice);
  const simpleBuyable = options.quickBuy && product.quickAddEligible === true && !soldOut && !product.hasVariants &&
    product.priceVaries !== true && product.discountedPrice > 0 &&
    !product.isGiftCard && !product.requiresCustomization && !product.customizationUnavailable &&
    (product.customization?.fields.length ?? 0) === 0;
  return {
    name: product.name,
    condition: product.productCondition ? PRODUCT_CONDITION_LABELS[product.productCondition] : null,
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
      current,
      parts: splitMoney(current, options.currencySymbol),
      regular: hasDiscount ? money(product.price) : null,
      prefix: product.priceVaries ? "From " : "",
    },
    percentOff: formatDiscountBadge(product.price, product.discountedPrice),
    amountOff: saved,
    // "Buy now" needs no choice from the buyer: in stock and without options.
    quickBuyHref: simpleBuyable
      ? `/buy/${encodeURIComponent(product.slug)}`
      : null,
    quickAddEligible: simpleBuyable,
    needsOptions: !soldOut && product.hasVariants,
    facts: cardFactValues(product.cardFacts, options.ratings === false ? { ...product, rating: null } : product, money, saved),
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
