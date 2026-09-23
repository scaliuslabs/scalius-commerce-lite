export interface OrderPaymentPresentation {
  /** Cancelled, returned or refunded orders collect no more money. */
  collectionClosed: boolean;
  amountDue: number;
}

const CLOSED_COLLECTION_ORDER_STATUSES = new Set([
  "cancelled",
  "returned",
  "refunded",
  "partially_refunded",
]);

export function buildOrderPaymentPresentation(input: {
  orderStatus: string;
  balanceDue: number | null | undefined;
}): OrderPaymentPresentation {
  const collectionClosed = CLOSED_COLLECTION_ORDER_STATUSES.has(
    input.orderStatus.trim().toLowerCase(),
  );
  const storedBalance = Number(input.balanceDue ?? 0);
  return {
    collectionClosed,
    amountDue: collectionClosed || !Number.isFinite(storedBalance)
      ? 0
      : Math.max(0, storedBalance),
  };
}
