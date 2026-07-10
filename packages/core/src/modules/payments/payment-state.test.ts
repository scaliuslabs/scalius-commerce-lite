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

  it("uses JPY zero-decimal precision for partial payments", () => {
    expect(computePaymentStateAfterPayment({
      totalAmount: 101.4,
      currentPaidAmount: 0,
      paymentAmount: 50.6,
      currency: { currencyCode: "JPY", currencyDecimalPlaces: 0 },
    })).toEqual({
      paidAmount: 51,
      balanceDue: 50,
      paymentStatus: PaymentStatus.PARTIAL,
    });
  });

  it("uses KWD three-decimal precision for refunds", () => {
    expect(computePaymentStateAfterRefund({
      totalAmount: 2.469,
      currentPaidAmount: 2.469,
      refundAmount: 1.2346,
      isFullRefund: false,
      currency: { currencyCode: "KWD", currencyDecimalPlaces: 3 },
    })).toEqual({
      paidAmount: 1.234,
      balanceDue: 1.235,
      paymentStatus: PaymentStatus.PARTIAL,
    });
  });
});
