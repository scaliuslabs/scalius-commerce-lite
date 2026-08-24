import type { CheckoutConfig } from "./types";

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
    throw new Error("A valid advance amount is required to continue payment.");
  }
  return { paymentType: "deposit", depositAmount: depositAmount! };
}

export function resolveCheckoutPaymentRequest(
  config: Pick<CheckoutConfig, "partialPaymentEnabled" | "partialPaymentAmount">,
  totalAmount: number,
): CheckoutPaymentRequest {
  const configuredDeposit = Number(config.partialPaymentAmount);
  if (
    config.partialPaymentEnabled &&
    Number.isFinite(configuredDeposit) &&
    configuredDeposit > 0 &&
    configuredDeposit < totalAmount
  ) {
    return { paymentType: "deposit", depositAmount: configuredDeposit };
  }

  return { paymentType: "full" };
}

export function isDepositPaymentRequired(
  config: Pick<CheckoutConfig, "partialPaymentEnabled" | "partialPaymentAmount">,
  totalAmount: number,
): boolean {
  return resolveCheckoutPaymentRequest(config, totalAmount).paymentType === "deposit";
}
