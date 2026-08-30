import { OrderStatus } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";

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
  [OrderStatus.PARTIALLY_REFUNDED]: [],
};

export function isGenericAdminOrderStatusTransitionAllowed(current: string, next: string): boolean {
  return current === next || (GENERIC_ADMIN_STATUS_TRANSITIONS[current] ?? []).includes(next);
}

export function assertGenericAdminOrderStatusTransition(current: string, next: string): void {
  if (isGenericAdminOrderStatusTransitionAllowed(current, next)) return;
  if (
    next === OrderStatus.RETURNED
    || next === OrderStatus.REFUNDED
    || next === OrderStatus.PARTIALLY_REFUNDED
  ) {
    throw new ValidationError(
      "Returns and refunds must use their dedicated item-level workflow.",
    );
  }
  throw new ValidationError(`The generic status editor cannot move an order from ${current} to ${next}.`);
}
