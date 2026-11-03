import { isDepositPaymentRequired } from "@scalius/shared/checkout-payment";
export { isDepositPaymentRequired } from "@scalius/shared/checkout-payment";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import { allowsCashOnDelivery } from "@scalius/shared/fulfilment";
import type { CheckoutConfig } from "./types";
import { CheckoutCopyError } from "./error-messages";

export type CheckoutPaymentRequest =
  | { paymentType: "deposit"; depositAmount: number }
  | { paymentType: "full" }
  | { paymentType: "balance" };

export function resolveExplicitCheckoutPaymentRequest(
  paymentType: NonNullable<CheckoutPaymentRequest["paymentType"]>,
  depositAmount?: number,
): CheckoutPaymentRequest {
  if (paymentType !== "deposit") return { paymentType };
  if (!Number.isFinite(depositAmount) || (depositAmount ?? 0) <= 0) {
    throw new CheckoutCopyError("paymentStartFailedText", "a deposit needs a positive advance amount");
  }
  return { paymentType: "deposit", depositAmount: depositAmount! };
}

export function resolveCheckoutPaymentRequest(
  config: Pick<CheckoutConfig, "partialPaymentEnabled" | "partialPaymentAmount" | "codDeposit">,
  totalAmount: number,
  /** The quoted lines' types: a download or a gift card is paid in full (no deposit plan). */
  lineTypes: readonly (FulfillmentType | null)[],
): CheckoutPaymentRequest {
  const configuredDeposit = Number(config.partialPaymentAmount);
  if (isDepositPaymentRequired(config, totalAmount, lineTypes)) {
    return { paymentType: "deposit", depositAmount: configuredDeposit };
  }

  return { paymentType: "full" };
}

/**
 * Whether a COD order on this cart requires a manual deposit before dispatch.
 * The deposit is collected offline (bank transfer, mobile wallet, cash at
 * counter), not charged online: the order is placed with `paymentMethod: "cod"`
 * and `paymentType: "full"`; staff verify the deposit in the admin.
 *
 * Eligible only when all of: physical lines (`allowsCashOnDelivery`), no gift
 * cards (handled by the caller), order currency === store currency, and the
 * configured deposit is strictly less than the order total.
 */
export function isManualCodDepositRequired(
  config: Pick<CheckoutConfig, "codDeposit">,
  totalAmount: number,
  lineTypes: readonly (FulfillmentType | null)[],
  storeCurrencyCode: string,
  orderCurrencyCode: string,
  decimalPlaces: number,
): boolean {
  const cd = config.codDeposit;
  if (!cd?.enabled) return false;
  if (!allowsCashOnDelivery(lineTypes)) return false;
  if (orderCurrencyCode !== storeCurrencyCode) return false;
  const totalMinor = Math.round(totalAmount * 10 ** decimalPlaces);
  const depositMinor = cd.mode === "fixed"
    ? Math.round(Number(cd.amount) * 10 ** decimalPlaces)
    : Math.min(totalMinor - 1, Math.ceil(totalMinor * Number(cd.percent) / 100));
  return Number.isFinite(depositMinor) && depositMinor > 0 && depositMinor < totalMinor;
}

/**
 * The deposit amount in major units for a manual COD deposit order, or null
 * when no manual deposit applies. Fixed mode uses `amount` as-is; percentage
 * mode rounds up in minor units and clamps so the deposit stays below total.
 */
export function manualCodDepositAmount(
  config: Pick<CheckoutConfig, "codDeposit">,
  totalAmount: number,
  decimalPlaces: number,
): number | null {
  const cd = config.codDeposit;
  if (!cd?.enabled) return null;
  const totalMinor = Math.round(totalAmount * 10 ** decimalPlaces);
  const minor = cd.mode === "fixed"
    ? Math.round(Number(cd.amount) * 10 ** decimalPlaces)
    : Math.min(totalMinor - 1, Math.ceil(totalMinor * Number(cd.percent) / 100));
  return Number.isFinite(minor) && minor > 0 && minor < totalMinor
    ? minor / 10 ** decimalPlaces
    : null;
}
