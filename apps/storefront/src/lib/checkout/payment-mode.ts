import type { CheckoutConfig } from "./types";

export type CheckoutPaymentRequest =
  | { paymentType: "deposit"; depositAmount: number }
  | { paymentType: "full" };

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
