export const ARCHIVABLE_ORDER_STATUSES = new Set<string>([
  "cancelled",
  // Delivered means sent and paid for (cash is recorded before delivery), so
  // it is finished work, as in Shopify (R3-ORD-11).
  "delivered",
  "completed",
  "returned",
  "refunded",
]);

/**
 * Archiving is intentionally narrower than cancelling. It only removes
 * finished commerce records from the default operational list and never
 * changes payment, fulfillment, return, refund, or inventory truth.
 */
export function getOrderArchiveStatusBlockedReason(status: string): string | null {
  if (ARCHIVABLE_ORDER_STATUSES.has(status)) return null;
  return "Only finished orders can be archived: delivered, cancelled, returned or refunded.";
}

export function isOrderArchiveStatusEligible(status: string): boolean {
  return getOrderArchiveStatusBlockedReason(status) == null;
}
