export interface OrderPaymentPresentationInput {
  orderStatus: string;
  balanceDue: number | null | undefined;
  codStatus: string | null | undefined;
}

export interface OrderPaymentPresentation {
  collectionClosed: boolean;
  amountDue: number;
  amountDueLabel: "Balance due" | "No payment due";
  cashCollectionLabel: string;
  recordedCodStatusLabel: string | null;
}

const CLOSED_COLLECTION_ORDER_STATUSES = new Set([
  "cancelled",
  "returned",
  "refunded",
  "partially_refunded",
]);

function titleCaseStatus(status: string | null | undefined): string {
  const normalized = status?.trim();
  if (!normalized) return "Not recorded";
  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function buildOrderPaymentPresentation(
  input: OrderPaymentPresentationInput,
): OrderPaymentPresentation {
  const collectionClosed = CLOSED_COLLECTION_ORDER_STATUSES.has(
    input.orderStatus.trim().toLowerCase(),
  );
  const storedBalance = Number(input.balanceDue ?? 0);
  const amountDue = collectionClosed || !Number.isFinite(storedBalance)
    ? 0
    : Math.max(0, storedBalance);

  return {
    collectionClosed,
    amountDue,
    amountDueLabel: collectionClosed ? "No payment due" : "Balance due",
    cashCollectionLabel: collectionClosed
      ? "Collection closed"
      : titleCaseStatus(input.codStatus),
    recordedCodStatusLabel: collectionClosed
      ? titleCaseStatus(input.codStatus)
      : null,
  };
}
