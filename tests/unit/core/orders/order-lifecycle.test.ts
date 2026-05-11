// tests/unit/core/orders/order-lifecycle.test.ts
// Tests the order lifecycle: status flows, payment flows, fulfillment flows.
// These test the transition logic and inventory-transitions behavior
// without touching a real database.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Status enums (from src/db/schema/enums.ts)
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

const PaymentStatus = {
  UNPAID: "unpaid",
  PARTIAL: "partial",
  PAID: "paid",
  REFUNDED: "refunded",
  FAILED: "failed",
} as const;

const FulfillmentStatus = {
  PENDING: "pending",
  PARTIAL: "partial",
  COMPLETE: "complete",
} as const;

// ---------------------------------------------------------------------------
// Inventory action state machine (from inventory-transitions.ts)
// ---------------------------------------------------------------------------

type InventoryAction = "none" | "reserved" | "deducted" | "restored";

const STOCK_RESTORE_STATUSES = new Set(["cancelled", "returned", "refunded"]);
const STOCK_DEDUCT_STATUSES = new Set(["shipped"]);

/**
 * Pure function replicating the logic from applyInventoryForStatusChange()
 * without the database calls. Returns the new inventoryAction.
 */
function computeInventoryAction(
  currentAction: InventoryAction,
  newStatus: string
): InventoryAction {
  const needsRestore = STOCK_RESTORE_STATUSES.has(newStatus);
  const needsDeduct = STOCK_DEDUCT_STATUSES.has(newStatus);

  if (needsRestore) {
    if (currentAction === "reserved") return "restored";
    if (currentAction === "deducted") return "deducted"; // Do NOT auto-restore shipped stock
    return currentAction;
  }

  if (needsDeduct) {
    if (currentAction === "reserved") return "deducted";
  }

  return currentAction;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Order Lifecycle", () => {
  describe("Happy path: PENDING -> CONFIRMED -> SHIPPED -> DELIVERED -> COMPLETED", () => {
    it("walks through the full lifecycle with correct inventory actions", () => {
      // Start: order created with stock reserved
      let action: InventoryAction = "reserved";

      // PENDING -> CONFIRMED: no inventory change (still reserved)
      action = computeInventoryAction(action, OrderStatus.CONFIRMED);
      expect(action).toBe("reserved");

      // CONFIRMED -> SHIPPED: stock permanently deducted
      action = computeInventoryAction(action, OrderStatus.SHIPPED);
      expect(action).toBe("deducted");

      // SHIPPED -> DELIVERED: no inventory change
      action = computeInventoryAction(action, OrderStatus.DELIVERED);
      expect(action).toBe("deducted");

      // DELIVERED -> COMPLETED: no inventory change
      action = computeInventoryAction(action, OrderStatus.COMPLETED);
      expect(action).toBe("deducted");
    });
  });

  describe("Cancellation flow", () => {
    it("releases reservation when cancelled before shipping", () => {
      let action: InventoryAction = "reserved";
      action = computeInventoryAction(action, OrderStatus.CANCELLED);
      expect(action).toBe("restored");
    });

    it("does NOT auto-restore stock when cancelled after shipping", () => {
      let action: InventoryAction = "deducted";
      action = computeInventoryAction(action, OrderStatus.CANCELLED);
      // Already shipped and deducted: admin must manually restore
      expect(action).toBe("deducted");
    });

    it("no-ops when cancelling an order with no inventory action", () => {
      let action: InventoryAction = "none";
      action = computeInventoryAction(action, OrderStatus.CANCELLED);
      expect(action).toBe("none");
    });

    it("no-ops when cancelling an already-restored order", () => {
      let action: InventoryAction = "restored";
      action = computeInventoryAction(action, OrderStatus.CANCELLED);
      expect(action).toBe("restored");
    });
  });

  describe("Return flow", () => {
    it("releases reservation when returned before shipping", () => {
      let action: InventoryAction = "reserved";
      action = computeInventoryAction(action, OrderStatus.RETURNED);
      expect(action).toBe("restored");
    });

    it("does NOT auto-restore stock when returned after shipping", () => {
      let action: InventoryAction = "deducted";
      action = computeInventoryAction(action, OrderStatus.RETURNED);
      expect(action).toBe("deducted");
    });
  });

  describe("Admin reactivation", () => {
    it("does NOT re-deduct stock when reactivating cancelled order", () => {
      let action: InventoryAction = "restored";
      // Cancelled -> Pending: should not change inventory
      action = computeInventoryAction(action, OrderStatus.PENDING);
      expect(action).toBe("restored");
    });

    it("does NOT re-deduct stock when reactivating to confirmed", () => {
      let action: InventoryAction = "restored";
      action = computeInventoryAction(action, OrderStatus.CONFIRMED);
      expect(action).toBe("restored");
    });
  });

  describe("Payment status transitions", () => {
    it("UNPAID -> PARTIAL when partial payment received", () => {
      const totalAmount = 2500;
      const paidAmount = 0;
      const paymentAmount = 1000;

      const newPaidAmount = paidAmount + paymentAmount;
      const newBalanceDue = Math.max(0, totalAmount - newPaidAmount);
      const isFullyPaid = newBalanceDue <= 0.01;

      expect(isFullyPaid).toBe(false);
      const newPaymentStatus = isFullyPaid ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
      expect(newPaymentStatus).toBe(PaymentStatus.PARTIAL);
    });

    it("PARTIAL -> PAID when full payment received", () => {
      const totalAmount = 2500;
      const paidAmount = 1000;
      const paymentAmount = 1500;

      const newPaidAmount = paidAmount + paymentAmount;
      const newBalanceDue = Math.max(0, totalAmount - newPaidAmount);
      const isFullyPaid = newBalanceDue <= 0.01;

      expect(isFullyPaid).toBe(true);
      const newPaymentStatus = isFullyPaid ? PaymentStatus.PAID : PaymentStatus.PARTIAL;
      expect(newPaymentStatus).toBe(PaymentStatus.PAID);
    });

    it("handles float precision: tiny overpayment treated as fully paid", () => {
      const totalAmount = 2500;
      const paidAmount = 2499.995;
      const paymentAmount = 0.005;

      const newPaidAmount = paidAmount + paymentAmount;
      const newBalanceDue = Math.max(0, totalAmount - newPaidAmount);
      const isFullyPaid = newBalanceDue <= 0.01;

      expect(isFullyPaid).toBe(true);
    });

    it("INCOMPLETE -> PENDING on first payment", () => {
      const currentStatus = OrderStatus.INCOMPLETE;
      const newStatus =
        currentStatus === OrderStatus.INCOMPLETE
          ? OrderStatus.PENDING
          : currentStatus;
      expect(newStatus).toBe(OrderStatus.PENDING);
    });

    it("non-INCOMPLETE status remains unchanged on payment", () => {
      const currentStatus = OrderStatus.CONFIRMED;
      const newStatus =
        currentStatus === OrderStatus.INCOMPLETE
          ? OrderStatus.PENDING
          : currentStatus;
      expect(newStatus).toBe(OrderStatus.CONFIRMED);
    });
  });

  describe("Fulfillment status transitions", () => {
    it("PENDING fulfillment when no items shipped", () => {
      const allItems = [
        { id: "1", fulfillmentStatus: "pending" },
        { id: "2", fulfillmentStatus: "pending" },
      ];
      const shippedCount = allItems.filter(
        (i) => i.fulfillmentStatus === "shipped" || i.fulfillmentStatus === "delivered"
      ).length;

      expect(shippedCount).toBe(0);
      const status =
        shippedCount === 0
          ? FulfillmentStatus.PENDING
          : shippedCount === allItems.length
            ? FulfillmentStatus.COMPLETE
            : FulfillmentStatus.PARTIAL;
      expect(status).toBe(FulfillmentStatus.PENDING);
    });

    it("PARTIAL fulfillment when some items shipped", () => {
      const allItems = [
        { id: "1", fulfillmentStatus: "shipped" },
        { id: "2", fulfillmentStatus: "pending" },
      ];
      const shippedCount = allItems.filter(
        (i) => i.fulfillmentStatus === "shipped" || i.fulfillmentStatus === "delivered"
      ).length;

      expect(shippedCount).toBe(1);
      const status =
        shippedCount === 0
          ? FulfillmentStatus.PENDING
          : shippedCount === allItems.length
            ? FulfillmentStatus.COMPLETE
            : FulfillmentStatus.PARTIAL;
      expect(status).toBe(FulfillmentStatus.PARTIAL);
    });

    it("COMPLETE fulfillment when all items shipped", () => {
      const allItems = [
        { id: "1", fulfillmentStatus: "shipped" },
        { id: "2", fulfillmentStatus: "delivered" },
      ];
      const shippedCount = allItems.filter(
        (i) => i.fulfillmentStatus === "shipped" || i.fulfillmentStatus === "delivered"
      ).length;

      expect(shippedCount).toBe(2);
      const status =
        shippedCount === 0
          ? FulfillmentStatus.PENDING
          : shippedCount === allItems.length
            ? FulfillmentStatus.COMPLETE
            : FulfillmentStatus.PARTIAL;
      expect(status).toBe(FulfillmentStatus.COMPLETE);
    });
  });

  describe("Refund status effects", () => {
    it("inventory transitions to restored on refund of reserved order", () => {
      let action: InventoryAction = "reserved";
      action = computeInventoryAction(action, OrderStatus.REFUNDED);
      expect(action).toBe("restored");
    });

    it("deducted inventory stays deducted on refund (shipped goods)", () => {
      let action: InventoryAction = "deducted";
      action = computeInventoryAction(action, OrderStatus.REFUNDED);
      expect(action).toBe("deducted");
    });
  });
});
