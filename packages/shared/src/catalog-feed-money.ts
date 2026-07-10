import Currency from "currency.js";

import { getDecimalPlaces } from "./currency";
import { calculateDiscountedPriceAtPrecision } from "./price-utils";

export type CatalogFeedDiscountType = "percentage" | "flat" | null | undefined;

export function normalizeCatalogFeedDiscountType(
  value: unknown,
): CatalogFeedDiscountType {
  return value === "percentage" || value === "flat" ? value : null;
}

/**
 * Merchant catalog feeds allow at most two fractional digits. The currencies
 * below conventionally emit none; all other configured currencies emit two,
 * including ISO currencies whose normal accounting precision is three.
 */
export function getCatalogFeedFractionDigits(currencyCode: string): number {
  return Math.min(getDecimalPlaces(currencyCode), 2);
}

/** Quantize once at the precision the catalog feed can actually emit. */
export function quantizeCatalogFeedAmount(
  amount: number,
  currencyCode: string,
): number {
  if (!Number.isFinite(amount)) return Number.NaN;
  return Currency(amount, {
    precision: getCatalogFeedFractionDigits(currencyCode),
  }).value;
}

/**
 * Calculate the effective price at configured currency precision, then
 * quantize it to the catalog's narrower output precision. XML generation and
 * diagnostics both use this exact order.
 */
export function calculateCatalogFeedDiscountedAmount(
  price: number,
  discountType: unknown,
  discountPercentage: number | null | undefined,
  discountAmount: number | null | undefined,
  currencyCode: string,
): number {
  const calculationPrecision = getDecimalPlaces(currencyCode);
  const normalizedDiscountType = normalizeCatalogFeedDiscountType(discountType);
  const effectivePrice = calculateDiscountedPriceAtPrecision(
    price,
    normalizedDiscountType,
    discountPercentage,
    discountAmount,
    calculationPrecision,
  );

  return quantizeCatalogFeedAmount(effectivePrice, currencyCode);
}

/** Format a catalog amount without asking native `toFixed` to round raw input. */
export function formatCatalogFeedAmount(
  amount: number,
  currencyCode: string,
): string | null {
  if (!Number.isFinite(amount)) return null;
  const fractionDigits = getCatalogFeedFractionDigits(currencyCode);
  const formatted = Currency(amount, { precision: fractionDigits }).format({
    symbol: "",
    separator: "",
    decimal: ".",
  });
  const plainDecimalPattern =
    fractionDigits === 0
      ? /^\d+$/
      : new RegExp(`^\\d+\\.\\d{${fractionDigits}}$`);
  return plainDecimalPattern.test(formatted) ? formatted : null;
}

export function isPositiveCatalogFeedAmount(
  amount: number,
  currencyCode: string,
): boolean {
  const formatted = formatCatalogFeedAmount(amount, currencyCode);
  return formatted !== null && Number(formatted) > 0;
}

export function isCatalogFeedSalePrice(
  basePrice: number,
  salePrice: number,
  currencyCode: string,
): boolean {
  if (
    formatCatalogFeedAmount(basePrice, currencyCode) === null ||
    formatCatalogFeedAmount(salePrice, currencyCode) === null
  ) {
    return false;
  }
  const quantizedBase = quantizeCatalogFeedAmount(basePrice, currencyCode);
  const quantizedSale = quantizeCatalogFeedAmount(salePrice, currencyCode);
  return (
    Number.isFinite(quantizedBase) &&
    Number.isFinite(quantizedSale) &&
    quantizedSale >= 0 &&
    quantizedSale < quantizedBase
  );
}
