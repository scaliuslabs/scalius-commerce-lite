const ARCHIVABLE_ORDER_STATUSES = new Set<string>([
  "cancelled",
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
  return "Complete, cancel, return, or fully refund this order before archiving it.";
}

export function isOrderArchiveStatusEligible(status: string): boolean {
  return getOrderArchiveStatusBlockedReason(status) == null;
}
