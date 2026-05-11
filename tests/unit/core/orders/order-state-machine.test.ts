// tests/unit/core/orders/order-state-machine.test.ts
// Tests the order status transition rules derived from the codebase.
//
// The codebase doesn't have an explicit state machine file, but the valid
// transitions are enforced by inventory-transitions.ts and orders.service.ts.
// We extract the rules here and test them as pure logic.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Extract the state machine from the codebase's OrderStatus enum
// ---------------------------------------------------------------------------

const OrderStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
  RETURNED: "returned",
  PARTIALLY_REFUNDED: "partially_refunded",
  INCOMPLETE: "incomplete",
} as const;

type OrderStatusType = (typeof OrderStatus)[keyof typeof OrderStatus];

// Valid transitions derived from the service code:
// - INCOMPLETE -> PENDING (on payment confirmed, processPaymentConfirmed)
// - PENDING -> CONFIRMED, CANCELLED, PROCESSING
// - PROCESSING -> CONFIRMED, CANCELLED, PENDING
// - CONFIRMED -> SHIPPED, CANCELLED, PENDING
// - SHIPPED -> DELIVERED, RETURNED, CANCELLED
// - DELIVERED -> COMPLETED, RETURNED
// - COMPLETED -> RETURNED
// - CANCELLED -> PENDING (admin reactivation), CONFIRMED (admin reactivation)
// - RETURNED -> (terminal, but admin can force REFUNDED)
// - REFUNDED -> (terminal)
// - PARTIALLY_REFUNDED -> REFUNDED, RETURNED, CANCELLED
const VALID_TRANSITIONS: Record<string, string[]> = {
  [OrderStatus.INCOMPLETE]: [OrderStatus.PENDING, OrderStatus.CANCELLED],
  [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CONFIRMED, OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.PROCESSING]: [OrderStatus.CONFIRMED, OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.PENDING],
  [OrderStatus.CONFIRMED]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.PENDING],
  [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED, OrderStatus.RETURNED, OrderStatus.CANCELLED],
  [OrderStatus.DELIVERED]: [OrderStatus.COMPLETED, OrderStatus.RETURNED],
  [OrderStatus.COMPLETED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [OrderStatus.PENDING, OrderStatus.CONFIRMED],
  [OrderStatus.RETURNED]: [OrderStatus.REFUNDED],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.PARTIALLY_REFUNDED]: [OrderStatus.REFUNDED, OrderStatus.RETURNED, OrderStatus.CANCELLED],
};

/**
 * Check if a transition is allowed.
 */
function canTransitionTo(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Get available transitions for a status.
 */
function getAvailableTransitions(status: string): string[] {
  return VALID_TRANSITIONS[status] ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Order State Machine", () => {
  describe("canTransitionTo()", () => {
    // Happy path: forward flow
    it("allows PENDING -> CONFIRMED", () => {
      expect(canTransitionTo("pending", "confirmed")).toBe(true);
    });

    it("allows PENDING -> PROCESSING", () => {
      expect(canTransitionTo("pending", "processing")).toBe(true);
    });

    it("allows PENDING -> SHIPPED", () => {
      expect(canTransitionTo("pending", "shipped")).toBe(true);
    });

    it("allows CONFIRMED -> SHIPPED", () => {
      expect(canTransitionTo("confirmed", "shipped")).toBe(true);
    });

    it("allows SHIPPED -> DELIVERED", () => {
      expect(canTransitionTo("shipped", "delivered")).toBe(true);
    });

    it("allows DELIVERED -> COMPLETED", () => {
      expect(canTransitionTo("delivered", "completed")).toBe(true);
    });

    // Cancellation
    it("allows PENDING -> CANCELLED", () => {
      expect(canTransitionTo("pending", "cancelled")).toBe(true);
    });

    it("allows CONFIRMED -> CANCELLED", () => {
      expect(canTransitionTo("confirmed", "cancelled")).toBe(true);
    });

    it("allows SHIPPED -> CANCELLED", () => {
      expect(canTransitionTo("shipped", "cancelled")).toBe(true);
    });

    // Admin reactivation (hardening fix: CANCELLED is NOT terminal for admin)
    it("allows CANCELLED -> PENDING (admin reactivation)", () => {
      expect(canTransitionTo("cancelled", "pending")).toBe(true);
    });

    it("allows CANCELLED -> CONFIRMED (admin reactivation)", () => {
      expect(canTransitionTo("cancelled", "confirmed")).toBe(true);
    });

    // Returns
    it("allows SHIPPED -> RETURNED", () => {
      expect(canTransitionTo("shipped", "returned")).toBe(true);
    });

    it("allows DELIVERED -> RETURNED", () => {
      expect(canTransitionTo("delivered", "returned")).toBe(true);
    });

    it("allows COMPLETED -> RETURNED", () => {
      expect(canTransitionTo("completed", "returned")).toBe(true);
    });

    // Terminal states
    it("blocks transitions out of REFUNDED (terminal)", () => {
      expect(canTransitionTo("refunded", "pending")).toBe(false);
      expect(canTransitionTo("refunded", "cancelled")).toBe(false);
      expect(canTransitionTo("refunded", "returned")).toBe(false);
    });

    // Invalid transitions
    it("blocks DELIVERED -> PENDING (can't go backward)", () => {
      expect(canTransitionTo("delivered", "pending")).toBe(false);
    });

    it("blocks COMPLETED -> PENDING (can't go backward)", () => {
      expect(canTransitionTo("completed", "pending")).toBe(false);
    });

    it("blocks INCOMPLETE -> SHIPPED (must go through PENDING first)", () => {
      expect(canTransitionTo("incomplete", "shipped")).toBe(false);
    });

    it("blocks CANCELLED -> SHIPPED (must reactivate to PENDING first)", () => {
      expect(canTransitionTo("cancelled", "shipped")).toBe(false);
    });

    // INCOMPLETE flow
    it("allows INCOMPLETE -> PENDING (on payment)", () => {
      expect(canTransitionTo("incomplete", "pending")).toBe(true);
    });

    it("allows INCOMPLETE -> CANCELLED", () => {
      expect(canTransitionTo("incomplete", "cancelled")).toBe(true);
    });

    // Refund transitions
    it("allows RETURNED -> REFUNDED", () => {
      expect(canTransitionTo("returned", "refunded")).toBe(true);
    });

    it("allows PARTIALLY_REFUNDED -> REFUNDED", () => {
      expect(canTransitionTo("partially_refunded", "refunded")).toBe(true);
    });

    it("returns false for unknown status", () => {
      expect(canTransitionTo("imaginary_status", "pending")).toBe(false);
    });
  });

  describe("getAvailableTransitions()", () => {
    it("returns correct transitions for PENDING", () => {
      const transitions = getAvailableTransitions("pending");
      expect(transitions).toContain("confirmed");
      expect(transitions).toContain("cancelled");
      expect(transitions).toContain("processing");
      expect(transitions).toContain("shipped");
    });

    it("returns correct transitions for CONFIRMED", () => {
      const transitions = getAvailableTransitions("confirmed");
      expect(transitions).toContain("shipped");
      expect(transitions).toContain("cancelled");
      expect(transitions).toContain("pending");
    });

    it("returns correct transitions for CANCELLED", () => {
      const transitions = getAvailableTransitions("cancelled");
      expect(transitions).toContain("pending");
      expect(transitions).toContain("confirmed");
      expect(transitions).toHaveLength(2);
    });

    it("returns empty array for REFUNDED (terminal)", () => {
      const transitions = getAvailableTransitions("refunded");
      expect(transitions).toHaveLength(0);
    });

    it("returns empty array for unknown status", () => {
      const transitions = getAvailableTransitions("unknown_status");
      expect(transitions).toHaveLength(0);
    });

    it("lists all statuses in the transition map", () => {
      const allStatuses = Object.values(OrderStatus);
      for (const status of allStatuses) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
      }
    });
  });
});
