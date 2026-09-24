import { OrderStatus } from "@scalius/database/schema";
import { ConflictError, ValidationError } from "@scalius/core/errors";

/**
 * The generic status editor is deliberately narrower than the internal order
 * state graph. Returns and refunds are workflow-owned because they require
 * item evidence, inventory dispositions, payment guards, and idempotency.
 */
const GENERIC_ADMIN_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  [OrderStatus.INCOMPLETE]: [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
  [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED],
  [OrderStatus.COMPLETED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]: [],
  [OrderStatus.REFUNDED]: [],
};

export function isGenericAdminOrderStatusTransitionAllowed(current: string, next: string): boolean {
  return current === next || (GENERIC_ADMIN_STATUS_TRANSITIONS[current] ?? []).includes(next);
}

export function assertGenericAdminOrderStatusTransition(current: string, next: string): void {
  if (isGenericAdminOrderStatusTransitionAllowed(current, next)) return;
  if (next === OrderStatus.RETURNED || next === OrderStatus.REFUNDED) {
    throw new ValidationError("Use Return or Refund on the order page for this.");
  }
  // The dashboard only offers allowed moves, so a refusal means the order
  // changed since it was loaded: answer 409 so the page reloads it.
  throw new ConflictError(
    `This order is now ${statusWords(current)}, so it can't be marked ${statusWords(next)}. Reload to see the latest.`,
  );
}

function statusWords(status: string): string {
  return status.replace(/_/g, " ");
}
