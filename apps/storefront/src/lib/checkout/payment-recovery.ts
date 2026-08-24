export function buildPaymentRecoveryUrl(options: {
  orderId: string;
  gateway: string;
  paymentType?: string;
  depositAmount?: number;
  result?: "failed" | "cancelled";
}): string {
  const params = new URLSearchParams({
    orderId: options.orderId,
    payment: options.gateway,
  });
  if (options.result) params.set("result", options.result);
  if (options.paymentType) params.set("paymentType", options.paymentType);
  if (typeof options.depositAmount === "number" && Number.isFinite(options.depositAmount)) {
    params.set("depositAmount", String(options.depositAmount));
  }
  return `/order-success?${params.toString()}`;
}
