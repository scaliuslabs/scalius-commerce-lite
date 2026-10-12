import { isPaymentMethodIdShape } from "../payment-method-id";
import { pagePath } from "../presence-url";

/** A referral to the existing proof-gated receipt, never authorization to read it. */
export function checkoutAttemptRecoveryHref(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const { orderId, paymentMethod } = details as Record<string, unknown>;
  if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) return null;
  if (paymentMethod != null && !isPaymentMethodIdShape(paymentMethod)) return null;
  const params = new URLSearchParams({ orderId });
  if (typeof paymentMethod === "string") params.set("payment", paymentMethod);
  return pagePath(`/order-success?${params}`);
}
