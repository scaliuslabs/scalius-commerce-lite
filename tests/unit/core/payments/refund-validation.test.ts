// tests/unit/core/payments/refund-validation.test.ts
// Tests refund validation logic from refund-service.ts.
// Covers amount validation, cumulative refunds, and inventory effects.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Enums (from src/db/schema/enums.ts)
// ---------------------------------------------------------------------------

const PaymentStatus = {
  UNPAID: "unpaid",
  PARTIAL: "partial",
  PAID: "paid",
  REFUNDED: "refunded",
  FAILED: "failed",
} as const;

const OrderStatus = {
  PENDING: "pending",
  CONFIRMED: "confirmed",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
  RETURNED: "returned",
} as const;

// ---------------------------------------------------------------------------
// Pure logic extracted from processRefund()
// ---------------------------------------------------------------------------

interface OrderRefundState {
  totalAmount: number;
  paidAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  status: string;
}

interface RefundValidationResult {
  valid: boolean;
  error?: string;
  refundAmount: number;
  isFullRefund: boolean;
  newPaidAmount: number;
  newPaymentStatus: string;
  shouldReleaseInventory: boolean;
}

function validateRefund(
  order: OrderRefundState,
  requestedAmount?: number,
): RefundValidationResult {
  // Guard: no payments to refund
  if (order.paymentStatus === PaymentStatus.UNPAID || order.paymentStatus === PaymentStatus.FAILED) {
    return {
      valid: false,
      error: "Order has no payments to refund",
      refundAmount: 0,
      isFullRefund: false,
      newPaidAmount: order.paidAmount,
      newPaymentStatus: order.paymentStatus,
      shouldReleaseInventory: false,
    };
  }

  // Guard: already fully refunded
  if (order.paymentStatus === PaymentStatus.REFUNDED) {
    return {
      valid: false,
      error: "Order is already fully refunded",
      refundAmount: 0,
      isFullRefund: false,
      newPaidAmount: order.paidAmount,
      newPaymentStatus: order.paymentStatus,
      shouldReleaseInventory: false,
    };
  }

  const refundAmount = requestedAmount ?? order.paidAmount;
  const isFullRefund = refundAmount >= order.paidAmount;

  // Validate: refund amount should not exceed paid amount
  if (refundAmount > order.paidAmount) {
    return {
      valid: false,
      error: `Refund amount (${refundAmount}) exceeds paid amount (${order.paidAmount})`,
      refundAmount,
      isFullRefund: true,
      newPaidAmount: order.paidAmount,
      newPaymentStatus: order.paymentStatus,
      shouldReleaseInventory: false,
    };
  }

  const newPaidAmount = Math.max(0, order.paidAmount - refundAmount);
  const newPaymentStatus = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL;

  // Full refund releases inventory; partial does NOT
  const shouldReleaseInventory = isFullRefund;

  return {
    valid: true,
    refundAmount,
    isFullRefund,
    newPaidAmount,
    newPaymentStatus,
    shouldReleaseInventory,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refund validation", () => {
  describe("guard checks", () => {
    it("rejects refund on UNPAID order", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.UNPAID,
        paymentMethod: "stripe",
        status: OrderStatus.PENDING,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("no payments to refund");
    });

    it("rejects refund on FAILED payment order", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.FAILED,
        paymentMethod: "stripe",
        status: OrderStatus.PENDING,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("no payments to refund");
    });

    it("rejects refund on already REFUNDED order", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 0,
        paymentStatus: PaymentStatus.REFUNDED,
        paymentMethod: "stripe",
        status: OrderStatus.CANCELLED,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain("already fully refunded");
    });
  });

  describe("amount validation", () => {
    it("rejects refund amount exceeding paidAmount", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 1000,
          paymentStatus: PaymentStatus.PARTIAL,
          paymentMethod: "stripe",
          status: OrderStatus.PENDING,
        },
        1500 // More than paidAmount
      );

      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds paid amount");
    });

    it("accepts refund equal to paidAmount (full refund)", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        2500
      );

      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(true);
      expect(result.newPaidAmount).toBe(0);
      expect(result.newPaymentStatus).toBe(PaymentStatus.REFUNDED);
    });

    it("accepts partial refund within paidAmount", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        500
      );

      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(false);
      expect(result.newPaidAmount).toBe(2000);
      expect(result.newPaymentStatus).toBe(PaymentStatus.PARTIAL);
    });

    it("defaults to full refund when no amount specified", () => {
      const result = validateRefund({
        totalAmount: 2500,
        paidAmount: 2500,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: "stripe",
        status: OrderStatus.CONFIRMED,
      });

      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(true);
      expect(result.refundAmount).toBe(2500);
    });
  });

  describe("inventory release on refund", () => {
    it("releases inventory on full refund", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        2500
      );

      expect(result.shouldReleaseInventory).toBe(true);
    });

    it("does NOT release inventory on partial refund", () => {
      const result = validateRefund(
        {
          totalAmount: 2500,
          paidAmount: 2500,
          paymentStatus: PaymentStatus.PAID,
          paymentMethod: "stripe",
          status: OrderStatus.CONFIRMED,
        },
        500
      );

      expect(result.shouldReleaseInventory).toBe(false);
    });
  });

  describe("cumulative refunds", () => {
    it("handles sequential partial refunds correctly", () => {
      let order: OrderRefundState = {
        totalAmount: 3000,
        paidAmount: 3000,
        paymentStatus: PaymentStatus.PAID,
        paymentMethod: "stripe",
        status: OrderStatus.CONFIRMED,
      };

      // First partial refund: 1000
      let result = validateRefund(order, 1000);
      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(false);
      expect(result.newPaidAmount).toBe(2000);
      expect(result.shouldReleaseInventory).toBe(false);

      // Apply the refund
      order = {
        ...order,
        paidAmount: result.newPaidAmount,
        paymentStatus: result.newPaymentStatus,
      };

      // Second partial refund: 1000
      result = validateRefund(order, 1000);
      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(false);
      expect(result.newPaidAmount).toBe(1000);
      expect(result.shouldReleaseInventory).toBe(false);

      // Apply the refund
      order = {
        ...order,
        paidAmount: result.newPaidAmount,
        paymentStatus: result.newPaymentStatus,
      };

      // Third refund: remaining 1000 (full refund)
      result = validateRefund(order, 1000);
      expect(result.valid).toBe(true);
      expect(result.isFullRefund).toBe(true);
      expect(result.newPaidAmount).toBe(0);
      expect(result.newPaymentStatus).toBe(PaymentStatus.REFUNDED);
      expect(result.shouldReleaseInventory).toBe(true);
    });

    it("rejects cumulative refund exceeding paid amount", () => {
      const order: OrderRefundState = {
        totalAmount: 3000,
        paidAmount: 1000, // After previous refunds
        paymentStatus: PaymentStatus.PARTIAL,
        paymentMethod: "stripe",
        status: OrderStatus.CONFIRMED,
      };

      const result = validateRefund(order, 1500);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("exceeds paid amount");
    });
  });
});
