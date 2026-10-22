// Customer erasure (final audit I10, migration 0179): the marker an erased
// field reads, and what erasure scrubs and keeps. The command is
// `eraseCustomer` (@scalius/core/modules/customers); `customer.erased`
// (@scalius/shared/events) tells apps and webhooks to erase their copies.

/**
 * The text an erased required field holds: a customer's and an order's name,
 * a shipped order's first street line, and a buyer's conversation message.
 * Optional fields are cleared (null) instead. The dashboard shows a
 * translated "Erased" for it; the conversation message guard (0179) allows a
 * buyer's message body to become exactly this and nothing else.
 */
export const ERASED_TEXT = "[erased]";

/** Whether a stored value is the erasure marker. */
export function isErasedText(value: string | null | undefined): boolean {
  return value === ERASED_TEXT;
}

/**
 * Order statuses that still owe the buyer something: an order in one of
 * them refuses erasure until it is delivered, completed or cancelled, so
 * nothing ships to an address that is gone.
 */
export const ERASURE_BLOCKING_ORDER_STATUSES = ["incomplete", "pending", "processing", "confirmed", "shipped"] as const;
