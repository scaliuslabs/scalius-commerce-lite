// src/components/product/lib/pricing-engine.ts
/**
 * Product page pricing, using the exact integer rule checkout charges
 * (`discountedPriceMinor`): a SKU's own price and discount win over the
 * product's, and in BDT percentage prices round to whole taka.
 */

import {
  DEFAULT_CURRENCY,
  formatMoney,
  getCurrencyCode,
  getDecimalPlaces,
} from "@/lib/currency";
import { isVariantAvailable } from "@/lib/product-sellable-variants";
import {
  discountedPriceMinor,
  fromMinor,
  percentToBps,
  toMinor,
} from "@scalius/shared/money";

export type DiscountType = "percentage" | "flat" | null | undefined;

export interface ProductPricing {
  basePrice: number;
  discountType: DiscountType;
  discountPercentage: number | null | undefined;
  discountAmount: number | null | undefined;
  currencyDecimalPlaces?: number;
  /** Store currency; defaults to the page currency (or BDT on the server). */
  currencyCode?: string;
}

export interface VariantPricing {
  price: number | null | undefined;
  discountType: DiscountType;
  discountPercentage: number | null | undefined;
  discountAmount: number | null | undefined;
}

export interface BuyerVariantPricing extends VariantPricing {
  stock: number;
  reservedStock?: number;
  trackInventory?: boolean;
}

export interface PriceCalculationResult {
  originalPrice: number;
  finalPrice: number;
  discountType: DiscountType;
  discountPercentage: number;
  discountAmount: number;
  hasDiscount: boolean;
  savingsAmount: number;
  savingsPercentage: number;
}

export interface BuyerVariantPricePresentation {
  /** True only when the buyer's choices really have different prices. */
  isStartingAt: boolean;
  pricing: PriceCalculationResult;
}

function currencyOf(pricing: ProductPricing): { code: string; places: number } {
  const code = pricing.currencyCode || getCurrencyCode() || DEFAULT_CURRENCY.code;
  const explicit = pricing.currencyDecimalPlaces;
  const places = Number.isInteger(explicit) && explicit! >= 0 && explicit! <= 3
    ? explicit!
    : getDecimalPlaces(code);
  return { code, places };
}

function hasValidDiscount(
  discountType: DiscountType,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
): boolean {
  return (discountType === "percentage" && (discountPercentage ?? 0) > 0)
    || (discountType === "flat" && (discountAmount ?? 0) > 0);
}

/** Amounts too large for minor units are not prices: they price at 0. */
function minor(value: number | null | undefined, places: number): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  try {
    return toMinor(value, places);
  } catch {
    return null;
  }
}

/**
 * The final price of a SKU (or of the product when `variantPricing` is null).
 * Variant price wins over product price; variant discount over product discount.
 */
export function calculateVariantPrice(
  productPricing: ProductPricing,
  variantPricing: VariantPricing | null,
): PriceCalculationResult {
  const { code, places } = currencyOf(productPricing);
  const rawBase = variantPricing?.price ?? productPricing.basePrice;
  const discount = variantPricing && hasValidDiscount(
    variantPricing.discountType,
    variantPricing.discountPercentage,
    variantPricing.discountAmount,
  )
    ? variantPricing
    : productPricing;
  const baseMinor = minor(rawBase, places);
  const discountMinor = minor(discount.discountAmount, places);
  const finalMinor = baseMinor === null || discountMinor === null
    ? 0
    : discountedPriceMinor(
        baseMinor,
        discount.discountType,
        percentToBps(discount.discountPercentage),
        discountMinor,
        code,
      );
  const originalPrice = fromMinor(baseMinor ?? 0, places);
  const finalPrice = fromMinor(finalMinor, places);
  const savingsAmount = fromMinor((baseMinor ?? 0) - finalMinor, places);
  return {
    originalPrice,
    finalPrice,
    discountType: discount.discountType,
    discountPercentage: discount.discountPercentage || 0,
    discountAmount: discount.discountAmount || 0,
    hasDiscount: savingsAmount > 0,
    savingsAmount,
    savingsPercentage: originalPrice > 0 ? Math.round((savingsAmount / originalPrice) * 100) : 0,
  };
}

/**
 * The truthful price shown before an exact optioned SKU is selected: the
 * lowest buyer-actionable price (or, when all are sold out, the lowest of
 * all), with "From" only when the choices are priced differently.
 */
export function getBuyerVariantPricePresentation(
  productPricing: ProductPricing,
  variants: BuyerVariantPricing[],
): BuyerVariantPricePresentation {
  if (variants.length === 0) {
    return { isStartingAt: false, pricing: calculateVariantPrice(productPricing, null) };
  }
  const available = variants.filter(isVariantAvailable);
  const priced = (available.length > 0 ? available : variants)
    .map((variant) => calculateVariantPrice(productPricing, variant));
  const pricing = priced.reduce((lowest, current) =>
    current.finalPrice < lowest.finalPrice ? current : lowest,
  );
  return {
    isStartingAt: priced.some((price) => price.finalPrice !== pricing.finalPrice),
    pricing,
  };
}

/** The store money format (see `formatMoney`). */
export function formatPrice(price: number, currencySymbol?: string): string {
  return formatMoney(price, currencySymbol ? { symbol: currencySymbol } : undefined);
}

/**
 * Discount badge, one format for every discount so a grid reads the same:
 * the share of the price the buyer saves ("-20%"), for a percentage or a
 * fixed amount off alike. Rounded down so it never promises more than the
 * struck-through price shows; the amount itself is on the price line.
 */
export function formatDiscountBadge(originalPrice: number, finalPrice: number): string | null {
  if (!(originalPrice > 0) || !(finalPrice < originalPrice)) return null;
  const percent = Math.floor(((originalPrice - Math.max(finalPrice, 0)) / originalPrice) * 100);
  return `-${Math.max(1, percent)}%`;
}

/** Final price of one SKU; see `calculateVariantPrice`. */
export function getVariantDiscountedPrice(
  variantPrice: number | null | undefined,
  productPrice: number,
  variantDiscountType: DiscountType,
  variantDiscountPercentage: number | null | undefined,
  variantDiscountAmount: number | null | undefined,
  productDiscountType: DiscountType,
  productDiscountPercentage: number | null | undefined,
  productDiscountAmount: number | null | undefined,
  currencyDecimalPlaces?: number,
  currencyCode?: string,
): number {
  return calculateVariantPrice(
    {
      basePrice: productPrice,
      discountType: productDiscountType,
      discountPercentage: productDiscountPercentage,
      discountAmount: productDiscountAmount,
      currencyDecimalPlaces,
      currencyCode,
    },
    {
      price: variantPrice,
      discountType: variantDiscountType,
      discountPercentage: variantDiscountPercentage,
      discountAmount: variantDiscountAmount,
    },
  ).finalPrice;
}
