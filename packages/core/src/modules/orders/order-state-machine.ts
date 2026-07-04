// src/modules/orders/order-state-machine.ts
// State machine for validating order status, payment status,
// and fulfillment status transitions. Prevents invalid status
// changes that would leave orders in inconsistent states.

import { ValidationError } from "@scalius/core/errors";
import {
    canTransitionTo as canSharedTransitionTo,
    getAvailableTransitions as getSharedAvailableTransitions,
    type StatusDimension,
} from "@scalius/shared/order-state";

// ─────────────────────────────────────────
// Status dimension enum for error messages
// ─────────────────────────────────────────

export type { StatusDimension };

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
    return canSharedTransitionTo(dimension, currentStatus, newStatus);
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
    return getSharedAvailableTransitions(dimension, currentStatus);
}
