import { OrderStatus } from "@scalius/database/schema";
import { ConflictError, ValidationError } from "@scalius/core/errors";

/**
 * The generic status editor only makes changes without side effects.
 * Shipped, delivered and returned are fulfilment facts: they come from Mark
 * as sent / Book courier, cash collected / Mark delivered and Mark returned,
 * which record what moved and move the stock with it (R3-ORD-01). Returns and
 * refunds are workflow-owned for the same reason. A Shipped order with nothing
 * actually sent (left by the old status override) may still be cancelled; the
 * cancel path refuses while any unit is with the courier.
 */
const GENERIC_ADMIN_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [OrderStatus.INCOMPLETE]: [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
  [OrderStatus.REFUNDED]: [],
};

/** Where each fulfilment or money status really comes from, in the merchant's words. */
const FULFILMENT_STATUS_PATHS: Readonly<Record<string, string>> = {
  [OrderStatus.SHIPPED]: "Use Mark as sent or Book courier: they record what left and move the stock.",
  [OrderStatus.DELIVERED]: "Record the cash as collected, or use Mark delivered once everything is sent.",
  [OrderStatus.RETURNED]: "Use Mark returned, or a return on the order page.",
  [OrderStatus.REFUNDED]: "Use Refund on the order page for this.",
};

export function isGenericAdminOrderStatusTransitionAllowed(current: string, next: string): boolean {
  return current === next || (GENERIC_ADMIN_STATUS_TRANSITIONS[current] ?? []).includes(next);
}

export function assertGenericAdminOrderStatusTransition(current: string, next: string): void {
  if (isGenericAdminOrderStatusTransitionAllowed(current, next)) return;
  const fulfilmentPath = FULFILMENT_STATUS_PATHS[next];
  if (fulfilmentPath) throw new ValidationError(fulfilmentPath);
  // The dashboard only offers allowed moves, so a refusal means the order
  // changed since it was loaded: answer 409 so the page reloads it.
  throw new ConflictError(
    `This order is now ${statusWords(current)}, so it can't be marked ${statusWords(next)}. Reload to see the latest.`,
  );
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}
