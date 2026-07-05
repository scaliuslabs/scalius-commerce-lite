export function buildPaymentRecoveryUrl(options: {
  orderId: string;
  gateway: string;
  paymentType?: string;
  depositAmount?: number;
}): string {
  const params = new URLSearchParams({
    orderId: options.orderId,
    payment: options.gateway,
    result: "failed",
  });
  if (options.paymentType) params.set("paymentType", options.paymentType);
  if (typeof options.depositAmount === "number" && Number.isFinite(options.depositAmount)) {
    params.set("depositAmount", String(options.depositAmount));
  }
  return `/order-success?${params.toString()}`;
}
