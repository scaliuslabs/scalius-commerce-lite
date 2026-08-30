import type { OrderItem } from "./types";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";

export interface ManualOrderDiscountLimit {
  maximumAmount: number;
  exceeded: boolean;
}

export interface ManualOrderDiscountGuidance
  extends ManualOrderDiscountLimit {
  source: "local" | "server";
  currencyCode: string;
  decimalPlaces: number;
}

interface AuthoritativeDiscountLimit {
  maximumAmount: number;
  currencyCode: string;
  decimalPlaces: number;
}

interface SuccessfulManualOrderQuote {
  subtotalAmount: number;
  shippingAmount: number;
  currencyCode: string;
  decimalPlaces: number;
}

export function manualOrderDiscountExceedsLimit(
  discountAmount: number | null,
  maximumAmount: number,
  decimalPlaces: number,
): boolean {
  if (
    discountAmount == null
    || !Number.isFinite(discountAmount)
    || !Number.isFinite(maximumAmount)
  ) {
    return false;
  }
  return roundPriceToPrecision(discountAmount, decimalPlaces)
    > roundPriceToPrecision(maximumAmount, decimalPlaces);
}

/**
 * Advisory discount boundary for the manual-order form.
 *
 * The API still recalculates catalog prices and enforces the authoritative
 * limit. This local projection exists only to avoid a guaranteed failing quote
 * request when the staged values already prove that the discount is invalid.
 */
export function calculateManualOrderDiscountLimit(
  items: OrderItem[],
  discountAmount: number | null,
  decimalPlaces: number,
): ManualOrderDiscountLimit | null {
  if (
    !Number.isInteger(decimalPlaces)
    || decimalPlaces < 0
    || decimalPlaces > 3
    || items.some((item) =>
      !Number.isFinite(item.price)
      || !Number.isInteger(item.quantity)
      || item.quantity < 1)
  ) {
    return null;
  }

  const subtotal = items.reduce((sum, item) => roundPriceToPrecision(
    sum + roundPriceToPrecision(
      roundPriceToPrecision(item.price, decimalPlaces) * item.quantity,
      decimalPlaces,
    ),
    decimalPlaces,
  ), 0);
  const maximumAmount = subtotal;
  return {
    maximumAmount,
    exceeded: manualOrderDiscountExceedsLimit(
      discountAmount,
      maximumAmount,
      decimalPlaces,
    ),
  };
}

export function resolveManualOrderDiscountGuidance(input: {
  discountAmount: number | null;
  authoritativeErrorLimit: AuthoritativeDiscountLimit | null;
  successfulQuote: SuccessfulManualOrderQuote | null;
  localLimit: ManualOrderDiscountLimit | null;
  localCurrencyCode: string;
  localDecimalPlaces: number;
}): ManualOrderDiscountGuidance | null {
  if (input.authoritativeErrorLimit) {
    return {
      ...input.authoritativeErrorLimit,
      exceeded: true,
      source: "server",
    };
  }

  if (input.successfulQuote) {
    const maximumAmount = roundPriceToPrecision(
      input.successfulQuote.subtotalAmount,
      input.successfulQuote.decimalPlaces,
    );
    return {
      maximumAmount,
      exceeded: manualOrderDiscountExceedsLimit(
        input.discountAmount,
        maximumAmount,
        input.successfulQuote.decimalPlaces,
      ),
      source: "server",
      currencyCode: input.successfulQuote.currencyCode,
      decimalPlaces: input.successfulQuote.decimalPlaces,
    };
  }

  return input.localLimit
    ? {
        ...input.localLimit,
        source: "local",
        currencyCode: input.localCurrencyCode,
        decimalPlaces: input.localDecimalPlaces,
      }
    : null;
}
