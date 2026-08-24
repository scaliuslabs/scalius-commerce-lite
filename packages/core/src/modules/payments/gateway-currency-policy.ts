import { normalizeSupportedCurrencyCode } from "@scalius/shared/currency";

export const PAYMENT_GATEWAY_IDS = [
  "stripe",
  "sslcommerz",
  "polar",
  "cod",
] as const;

export type PaymentGatewayId = (typeof PAYMENT_GATEWAY_IDS)[number];

export function isPaymentGatewayId(value: unknown): value is PaymentGatewayId {
  return typeof value === "string"
    && PAYMENT_GATEWAY_IDS.includes(value as PaymentGatewayId);
}

/**
 * Store-currency eligibility shared by every checkout control surface.
 * Credential readiness remains a separate concern.
 */
export function isPaymentGatewayCurrencyEligible(
  gatewayId: string,
  currencyCode: unknown,
): boolean {
  if (!isPaymentGatewayId(gatewayId)) return false;
  const normalizedCurrency = normalizeSupportedCurrencyCode(currencyCode);
  if (!normalizedCurrency) return false;
  if (gatewayId === "sslcommerz") return normalizedCurrency === "BDT";
  return true;
}

export function filterPaymentGatewayIdsForCurrency(
  gatewayIds: readonly string[],
  currencyCode: unknown,
): PaymentGatewayId[] {
  return gatewayIds.filter(
    (gatewayId): gatewayId is PaymentGatewayId =>
      isPaymentGatewayId(gatewayId)
      && isPaymentGatewayCurrencyEligible(gatewayId, currencyCode),
  );
}

export function getPaymentGatewayCurrencyEligibilityIssue(
  gatewayId: string,
  currencyCode: unknown,
): string | null {
  if (!isPaymentGatewayId(gatewayId)) {
    return "This payment method is not supported by checkout.";
  }
  const normalizedCurrency = normalizeSupportedCurrencyCode(currencyCode);
  if (!normalizedCurrency) {
    return "Store currency is unavailable. Save a supported currency before enabling payment methods.";
  }
  if (gatewayId === "sslcommerz" && normalizedCurrency !== "BDT") {
    return `SSLCommerz checkout requires the store currency to be BDT. Current currency: ${normalizedCurrency}.`;
  }
  return null;
}
