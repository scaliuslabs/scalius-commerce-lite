// The payment gateway registry. Adding a gateway is one adapter file in this
// directory plus one line in PAYMENT_GATEWAYS; nothing else branches on its id.
// Cash on delivery is not a gateway: the kernel records it without a provider.

import { ValidationError } from "@scalius/core/errors";
import { getDecimalPlaces, normalizeSupportedCurrencyCode } from "@scalius/shared/currency";
import type { PaymentGateway } from "./port";
import { minorToMajorString } from "./port";
import { sslcommerzGateway } from "./sslcommerz";
import { stripeGateway } from "./stripe";

export const PAYMENT_GATEWAYS: Record<string, PaymentGateway> = {
  stripe: stripeGateway,
  sslcommerz: sslcommerzGateway,
};

export const COD_PAYMENT_METHOD = "cod";
export const COD_LABEL = "Cash on Delivery";

export function getPaymentGateway(id: string | null | undefined): PaymentGateway | undefined {
  return id && Object.hasOwn(PAYMENT_GATEWAYS, id) ? PAYMENT_GATEWAYS[id] : undefined;
}

export function requirePaymentGateway(id: string | null | undefined): PaymentGateway {
  const gateway = getPaymentGateway(id);
  if (!gateway) throw new ValidationError(`Unsupported payment gateway: ${id ?? "none"}`);
  return gateway;
}

export function listPaymentGateways(): PaymentGateway[] {
  return Object.values(PAYMENT_GATEWAYS);
}

/** Every storefront payment method id: the registered gateways plus COD. */
export function listPaymentMethodIds(): string[] {
  return [...Object.keys(PAYMENT_GATEWAYS), COD_PAYMENT_METHOD];
}

export function isOnlinePaymentMethod(id: unknown): id is string {
  return typeof id === "string" && getPaymentGateway(id) !== undefined;
}

export function isPaymentMethodId(id: unknown): id is string {
  return id === COD_PAYMENT_METHOD || isOnlinePaymentMethod(id);
}

export function paymentMethodLabel(id: string): string {
  return id === COD_PAYMENT_METHOD ? COD_LABEL : getPaymentGateway(id)?.label ?? id;
}

/** Store-currency eligibility shared by every checkout surface; credential readiness is separate. */
export function getPaymentMethodCurrencyIssue(id: string, currencyCode: unknown): string | null {
  if (!isPaymentMethodId(id)) return "This payment method is not supported by checkout.";
  const currency = normalizeSupportedCurrencyCode(currencyCode);
  if (!currency) return "Store currency is unavailable. Save a supported currency before enabling payment methods.";
  const gateway = getPaymentGateway(id);
  if (gateway && gateway.currencies !== "any" && !gateway.currencies.includes(currency)) {
    return `${gateway.label} checkout requires the store currency to be ${gateway.currencies.join(" or ")}. Current currency: ${currency}.`;
  }
  return null;
}

export function isPaymentMethodCurrencyEligible(id: string, currencyCode: unknown): boolean {
  return getPaymentMethodCurrencyIssue(id, currencyCode) === null;
}

export function filterPaymentMethodsForCurrency(ids: readonly string[], currencyCode: unknown): string[] {
  return ids.filter((id) => isPaymentMethodCurrencyEligible(id, currencyCode));
}

/** Provider charge limits, checked before an order commits and before a session is created. */
export function getGatewayAmountIssue(
  gateway: PaymentGateway,
  amountMinor: number,
  currency: string,
  label = `${gateway.label} payment amount`,
): string | null {
  const limits = gateway.amountLimits;
  if (!limits || limits.currency !== currency.toUpperCase()) return null;
  if (Number.isSafeInteger(amountMinor) && amountMinor >= limits.minMinor && amountMinor <= limits.maxMinor) return null;
  const decimals = getDecimalPlaces(limits.currency);
  return `${label} must be between ${minorToMajorString(limits.minMinor, decimals)} ${limits.currency} and ${minorToMajorString(limits.maxMinor, decimals)} ${limits.currency}.`;
}

/**
 * Checks an online checkout must pass before its order commits: the store
 * currency is one the gateway settles, and the first charge (the configured
 * advance when it is below the total, else the total) is within provider limits.
 */
export function getCheckoutGatewayPrecommitIssue(input: {
  paymentMethod: string;
  currencyCode: string;
  totalAmount: number;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
}): string | null {
  const gateway = getPaymentGateway(input.paymentMethod);
  if (!gateway) return null;
  const currencyIssue = getPaymentMethodCurrencyIssue(gateway.id, input.currencyCode);
  if (currencyIssue) return currencyIssue;
  const scale = 10 ** getDecimalPlaces(input.currencyCode);
  const totalMinor = Math.round(Number(input.totalAmount) * scale);
  const depositMinor = Math.round(Number(input.partialPaymentAmount) * scale);
  const chargeMinor = input.partialPaymentEnabled && depositMinor > 0 && depositMinor < totalMinor
    ? depositMinor
    : totalMinor;
  return getGatewayAmountIssue(gateway, chargeMinor, input.currencyCode);
}

/** Public checkout copy of a gateway's limits, in major units. */
export function publicAmountLimits(gateway: PaymentGateway): { currency: string; min: number; max: number } | undefined {
  const limits = gateway.amountLimits;
  if (!limits) return undefined;
  const scale = 10 ** getDecimalPlaces(limits.currency);
  return { currency: limits.currency, min: limits.minMinor / scale, max: limits.maxMinor / scale };
}
