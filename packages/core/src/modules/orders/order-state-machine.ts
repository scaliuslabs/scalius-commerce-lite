// src/modules/orders/order-state-machine.ts
// State machine for validating order status, payment status,
// and fulfillment status transitions. Prevents invalid status
// changes that would leave orders in inconsistent states.

import {
    OrderStatus,
    PaymentStatus,
    FulfillmentStatus,
} from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";

// ─────────────────────────────────────────
// Order Status Transitions
// ─────────────────────────────────────────

type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

const ORDER_STATUS_TRANSITIONS: Record<OrderStatusValue, readonly OrderStatusValue[]> = {
    [OrderStatus.INCOMPLETE]: [OrderStatus.PENDING, OrderStatus.CANCELLED],
    [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
    [OrderStatus.PROCESSING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
    [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.CANCELLED],
    // `shipped -> confirmed` is used when a carrier delivery attempt fails and
    // the merchant needs to retry shipment without restoring/deducting stock.
    [OrderStatus.SHIPPED]: [OrderStatus.CONFIRMED, OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.CANCELLED],
    [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.RETURNED, OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED],
    [OrderStatus.COMPLETED]: [OrderStatus.RETURNED, OrderStatus.REFUNDED, OrderStatus.PARTIALLY_REFUNDED],
    // Admin override only: merchants can reactivate cancelled orders.
    // Inventory re-reservation is handled by buildInventoryStatements() in
    // inventory-transitions.ts when transitioning FROM a restored status
    // back to a non-terminal status. Storefront code should never trigger
    // these transitions — enforce via route-level auth, not the state machine.
    [OrderStatus.CANCELLED]: [OrderStatus.PENDING, OrderStatus.CONFIRMED],
    [OrderStatus.RETURNED]: [OrderStatus.REFUNDED],
    [OrderStatus.REFUNDED]: [],
    [OrderStatus.PARTIALLY_REFUNDED]: [OrderStatus.REFUNDED],
} as const;

// ─────────────────────────────────────────
// Payment Status Transitions
// ─────────────────────────────────────────

type PaymentStatusValue = (typeof PaymentStatus)[keyof typeof PaymentStatus];

const PAYMENT_STATUS_TRANSITIONS: Record<PaymentStatusValue, readonly PaymentStatusValue[]> = {
    [PaymentStatus.UNPAID]: [PaymentStatus.PARTIAL, PaymentStatus.PAID, PaymentStatus.FAILED],
    [PaymentStatus.PARTIAL]: [PaymentStatus.PAID, PaymentStatus.UNPAID, PaymentStatus.REFUNDED, PaymentStatus.FAILED],
    [PaymentStatus.PAID]: [PaymentStatus.PARTIAL, PaymentStatus.REFUNDED],
    [PaymentStatus.REFUNDED]: [],
    [PaymentStatus.FAILED]: [PaymentStatus.UNPAID, PaymentStatus.PARTIAL, PaymentStatus.PAID],
} as const;

// ─────────────────────────────────────────
// Fulfillment Status Transitions
// ─────────────────────────────────────────

type FulfillmentStatusValue = (typeof FulfillmentStatus)[keyof typeof FulfillmentStatus];

const FULFILLMENT_STATUS_TRANSITIONS: Record<FulfillmentStatusValue, readonly FulfillmentStatusValue[]> = {
    [FulfillmentStatus.PENDING]: [FulfillmentStatus.PARTIAL, FulfillmentStatus.COMPLETE],
    [FulfillmentStatus.PARTIAL]: [FulfillmentStatus.COMPLETE, FulfillmentStatus.PENDING],
    [FulfillmentStatus.COMPLETE]: [FulfillmentStatus.PENDING],
} as const;

// ─────────────────────────────────────────
// Status dimension enum for error messages
// ─────────────────────────────────────────

export type StatusDimension = "order" | "payment" | "fulfillment";

function getTransitionMap(dimension: StatusDimension): Record<string, readonly string[]> {
    switch (dimension) {
        case "order":
            return ORDER_STATUS_TRANSITIONS;
        case "payment":
            return PAYMENT_STATUS_TRANSITIONS;
        case "fulfillment":
            return FULFILLMENT_STATUS_TRANSITIONS;
    }
}

// ─────────────────────────────────────────
// Public API
// ─────────────────────────────────────────

/**
 * Returns true if transitioning from `currentStatus` to `newStatus`
 * is allowed for the given status dimension.
 */
export function canTransitionTo(
    dimension: StatusDimension,
    currentStatus: string,
    newStatus: string,
): boolean {
    if (currentStatus === newStatus) return true;

    const transitions = getTransitionMap(dimension);
    const allowed = transitions[currentStatus];
    if (!allowed) return false;

    return allowed.includes(newStatus);
}

/**
 * Throws a ValidationError if the transition is not allowed.
 * No-ops when currentStatus === newStatus.
 */
export function validateTransition(
    dimension: StatusDimension,
    currentStatus: string,
    newStatus: string,
): void {
    if (currentStatus === newStatus) return;

    if (!canTransitionTo(dimension, currentStatus, newStatus)) {
        const available = getAvailableTransitions(dimension, currentStatus);
        const availableStr = available.length > 0
            ? available.join(", ")
            : "none (terminal state)";
        throw new ValidationError(
            `Invalid ${dimension} status transition: "${currentStatus}" → "${newStatus}". ` +
            `Allowed transitions from "${currentStatus}": ${availableStr}.`,
        );
    }
}

/**
 * Returns the list of statuses that `currentStatus` can transition to.
 */
export function getAvailableTransitions(
    dimension: StatusDimension,
    currentStatus: string,
): string[] {
    const transitions = getTransitionMap(dimension);
    const allowed = transitions[currentStatus];
    if (!allowed) return [];
    return [...allowed];
}
