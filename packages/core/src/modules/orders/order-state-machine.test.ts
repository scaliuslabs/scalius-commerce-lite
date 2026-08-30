import { describe, expect, it } from "vitest";
import {
    FulfillmentStatus,
    OrderStatus,
    PaymentStatus,
} from "@scalius/database/schema";
import {
    FULFILLMENT_STATUSES,
    ORDER_STATUSES,
    PAYMENT_STATUSES,
    getAvailableOrderStatusTransitions,
} from "@scalius/shared/order-state";
import {
    canTransitionTo,
    getAvailableTransitions,
    validateTransition,
} from "./order-state-machine";

function expectSameValues(actual: readonly string[], expected: Record<string, string>) {
    expect([...actual].sort()).toEqual(Object.values(expected).sort());
}

describe("order state machine", () => {
    it("keeps the shared status lists aligned with database enum values", () => {
        expectSameValues(ORDER_STATUSES, OrderStatus);
        expectSameValues(PAYMENT_STATUSES, PaymentStatus);
        expectSameValues(FULFILLMENT_STATUSES, FulfillmentStatus);
    });

    it("uses the shared transition map for API validation and admin UI choices", () => {
        expect(getAvailableOrderStatusTransitions("confirmed")).toEqual([
            "shipped",
            "delivered",
            "cancelled",
        ]);
        expect(getAvailableOrderStatusTransitions("shipped")).toEqual([
            "confirmed",
            "delivered",
            "returned",
            "cancelled",
        ]);
        expect(getAvailableTransitions("order", "confirmed")).toEqual(
            getAvailableOrderStatusTransitions("confirmed"),
        );
        expect(canTransitionTo("order", "confirmed", "delivered")).toBe(true);
        expect(canTransitionTo("order", "shipped", "confirmed")).toBe(true);
    });

    it("normalizes whitespace and casing before transition checks", () => {
        expect(getAvailableOrderStatusTransitions(" Confirmed ")).toEqual([
            "shipped",
            "delivered",
            "cancelled",
        ]);
        expect(canTransitionTo("order", " SHIPPED ", "confirmed")).toBe(true);
        expect(() => validateTransition("order", "shipped", " DELIVERED "))
            .not.toThrow();
    });

    it("treats cancellation as a terminal order state", () => {
        expect(getAvailableOrderStatusTransitions("cancelled")).toEqual([]);
        expect(canTransitionTo("order", "cancelled", "pending")).toBe(false);
        expect(canTransitionTo("order", "cancelled", "confirmed")).toBe(false);
        expect(() => validateTransition("order", "cancelled", "pending"))
            .toThrow('Allowed transitions from "cancelled": none (terminal state).');
    });

    it("rejects transitions outside the shared state machine", () => {
        expect(() => validateTransition("order", "pending", "refunded"))
            .toThrow("Allowed transitions from \"pending\": processing, confirmed, cancelled.");
    });
});
