import { describe, expect, it } from "vitest";
import { PaymentStatus } from "@scalius/database/schema";
import {
  computeOrderPaymentState,
  computePaymentStateAfterPayment,
  computePaymentStateAfterRefund,
} from "./payment-state";

describe("payment-state helpers", () => {
  it("computes unpaid, partial, and paid states from total and paid amounts", () => {
    expect(computeOrderPaymentState({ totalAmount: 100, paidAmount: 0 })).toEqual({
      paidAmount: 0,
      balanceDue: 100,
      paymentStatus: PaymentStatus.UNPAID,
    });

    expect(computePaymentStateAfterPayment({
      totalAmount: 100,
      currentPaidAmount: 0,
      paymentAmount: 40,
    })).toEqual({
      paidAmount: 40,
      balanceDue: 60,
      paymentStatus: PaymentStatus.PARTIAL,
    });

    expect(computePaymentStateAfterPayment({
      totalAmount: 100,
      currentPaidAmount: 40,
      paymentAmount: 60,
    })).toEqual({
      paidAmount: 100,
      balanceDue: 0,
      paymentStatus: PaymentStatus.PAID,
    });
  });

  it("recomputes balance due after partial and full refunds", () => {
    expect(computePaymentStateAfterRefund({
      totalAmount: 100,
      currentPaidAmount: 100,
      refundAmount: 25,
      isFullRefund: false,
    })).toEqual({
      paidAmount: 75,
      balanceDue: 25,
      paymentStatus: PaymentStatus.PARTIAL,
    });

    expect(computePaymentStateAfterRefund({
      totalAmount: 100,
      currentPaidAmount: 100,
      refundAmount: 100,
      isFullRefund: true,
    })).toEqual({
      paidAmount: 0,
      balanceDue: 100,
      paymentStatus: PaymentStatus.REFUNDED,
    });
  });
});
