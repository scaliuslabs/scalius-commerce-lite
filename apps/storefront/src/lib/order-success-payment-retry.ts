import type { OrderReceipt } from "./api/types";
import type { OrderSuccessStateKind } from "./order-success-state";

export type OrderSuccessRetryPaymentType = "full" | "deposit" | "balance";

const RETRYABLE_HOSTED_METHODS = new Set(["sslcommerz", "polar"]);
const RETRYABLE_CALLBACK_RESULTS = new Set(["failed", "cancelled"]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isRetryableHostedPaymentMethod(paymentMethod: string | null | undefined): boolean {
  return RETRYABLE_HOSTED_METHODS.has(normalize(paymentMethod));
}

export function getOrderSuccessRetryEndpoint(paymentMethod: string | null | undefined): string | null {
  const method = normalize(paymentMethod);
  if (method === "sslcommerz") return "/api/checkout/sslcommerz-session";
  if (method === "polar") return "/api/checkout/polar-session";
  return null;
}

export function isHostedPaymentRetryResult(result: string | null | undefined): boolean {
  return RETRYABLE_CALLBACK_RESULTS.has(normalize(result));
}

export function canRetryOrderSuccessPayment(
  order: Pick<OrderReceipt, "paymentMethod">,
  stateKind: OrderSuccessStateKind,
  callbackResult: string | null | undefined,
): boolean {
  if (!isRetryableHostedPaymentMethod(order.paymentMethod)) return false;
  return stateKind === "payment_issue" || isHostedPaymentRetryResult(callbackResult);
}

export function resolveOrderSuccessRetryPaymentType(
  order: Pick<OrderReceipt, "paymentStatus" | "paidAmount" | "balanceDue">,
  requestedType: string | null | undefined,
): OrderSuccessRetryPaymentType {
  const requested = normalize(requestedType);
  if (requested === "deposit" || requested === "balance" || requested === "full") {
    return requested;
  }

  const paidAmount = Number(order.paidAmount ?? 0);
  const balanceDue = Number(order.balanceDue ?? 0);
  const paymentStatus = normalize(order.paymentStatus);
  if (paymentStatus === "partial" || (paidAmount > 0 && balanceDue > 0)) {
    return "balance";
  }

  return "full";
}

export function normalizeRetryDepositAmount(value: string | null | undefined): number | null {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}
