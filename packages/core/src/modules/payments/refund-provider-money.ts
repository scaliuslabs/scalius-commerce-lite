import { ValidationError } from "@scalius/core/errors";
import {
  getDecimalPlaces,
  normalizeSupportedCurrencyCode,
  type SupportedCurrencyCode,
} from "@scalius/shared/currency";
import { roundPriceToPrecision } from "@scalius/shared/price-utils";

import type { OrderCurrencySnapshot } from "./order-currency";

export interface RefundProviderMoney {
  amountMinor: number;
  currency: SupportedCurrencyCode;
}

export interface PolarRefundSourcePayment {
  amount: number;
  metadata: string | Record<string, unknown> | null | undefined;
}

function parseMetadata(value: string | Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toPositiveMinorAmount(
  amount: number,
  decimalPlaces: number,
  label: string,
): number {
  const normalized = roundPriceToPrecision(amount, decimalPlaces);
  const amountMinor = Math.round(normalized * 10 ** decimalPlaces);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError(`${label} must resolve to a positive provider amount.`);
  }
  return amountMinor;
}

function nativeRoundToPrecision(amount: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(amount * factor) / factor;
}

function nativeRoundedMinorAmount(
  amount: number,
  decimalPlaces: number,
  label: string,
): number {
  const rounded = nativeRoundToPrecision(amount, decimalPlaces);
  const amountMinor = Math.round(rounded * 10 ** decimalPlaces);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ValidationError(`${label} must resolve to a positive provider amount.`);
  }
  return amountMinor;
}

export function resolveStripeRefundProviderMoney(
  localAmount: number,
  currency: OrderCurrencySnapshot,
): RefundProviderMoney {
  return {
    amountMinor: toPositiveMinorAmount(
      localAmount,
      currency.decimalPlaces,
      "Stripe refund",
    ),
    currency: currency.code,
  };
}

/**
 * Resolve the exact Polar amount/currency that was used for the source payment.
 * New Polar payments always persist these fields. Missing or contradictory
 * metadata must fail closed because treating local major units as provider
 * major units can over-refund a converted payment.
 */
export function resolvePolarRefundProviderMoney(
  localAmount: number,
  currency: OrderCurrencySnapshot,
  sourcePayment: PolarRefundSourcePayment,
): RefundProviderMoney {
  const metadata = parseMetadata(sourcePayment.metadata);
  const originalCurrency = normalizeSupportedCurrencyCode(metadata.originalCurrency);
  const gatewayCurrency = normalizeSupportedCurrencyCode(metadata.gatewayCurrency);
  const exchangeRate = Number(metadata.exchangeRate);
  const originalAmount = Number(metadata.originalAmount);
  const gatewayAmount = Number(metadata.gatewayAmount);

  if (originalCurrency !== currency.code || !gatewayCurrency) {
    throw new ValidationError(
      "Polar payment currency metadata is missing or does not match the immutable order currency.",
    );
  }
  if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    throw new ValidationError("Polar payment exchange-rate metadata is missing or invalid.");
  }
  if (
    !Number.isFinite(originalAmount) || originalAmount <= 0 ||
    !Number.isFinite(gatewayAmount) || gatewayAmount <= 0
  ) {
    throw new ValidationError("Polar payment amount metadata is missing or invalid.");
  }
  const normalizedSourceAmount = roundPriceToPrecision(
    sourcePayment.amount,
    currency.decimalPlaces,
  );
  if (
    roundPriceToPrecision(originalAmount, currency.decimalPlaces) !==
    normalizedSourceAmount
  ) {
    throw new ValidationError("Polar payment amount metadata does not match the local source payment.");
  }

  const gatewayDecimalPlaces = gatewayCurrency === currency.code
    ? currency.decimalPlaces
    : getDecimalPlaces(gatewayCurrency);
  let expectedCapturedGatewayAmount: number;
  if (gatewayCurrency === currency.code) {
    if (exchangeRate !== 1) {
      throw new ValidationError("Polar payment exchange-rate metadata conflicts with its currency.");
    }
    expectedCapturedGatewayAmount = nativeRoundToPrecision(
      originalAmount,
      gatewayDecimalPlaces,
    );
  } else {
    if (gatewayCurrency !== "USD") {
      throw new ValidationError("Polar converted payment currency is unsupported for refund reconciliation.");
    }
    // Match payment-session creation exactly. Native Math.round is intentional:
    // using currency.js here can disagree at binary half-cent boundaries.
    expectedCapturedGatewayAmount = nativeRoundToPrecision(
      originalAmount / exchangeRate,
      gatewayDecimalPlaces,
    );
  }
  if (
    nativeRoundToPrecision(gatewayAmount, gatewayDecimalPlaces) !==
    expectedCapturedGatewayAmount
  ) {
    throw new ValidationError("Polar payment gateway amount metadata is inconsistent with its exchange rate.");
  }

  const normalizedRefundAmount = roundPriceToPrecision(
    localAmount,
    currency.decimalPlaces,
  );
  const providerRefundAmount = normalizedRefundAmount === normalizedSourceAmount
    ? gatewayAmount
    : gatewayCurrency === currency.code
      ? normalizedRefundAmount
      : normalizedRefundAmount / exchangeRate;
  return {
    amountMinor: nativeRoundedMinorAmount(
      providerRefundAmount,
      gatewayDecimalPlaces,
      "Polar refund",
    ),
    currency: gatewayCurrency,
  };
}
