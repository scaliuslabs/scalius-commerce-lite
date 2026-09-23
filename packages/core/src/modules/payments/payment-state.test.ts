import { describe, expect, it } from "vitest";
import { PaymentStatus } from "@scalius/database/schema";
import { computeOrderPaymentState, computePaymentStateAfterPayment } from "./payment-state";

describe("payment-state helpers", () => {
  it("computes unpaid, partial, and paid states from integer minor units", () => {
    expect(computeOrderPaymentState({ totalAmountMinor: 10_000, paidAmountMinor: 0 })).toEqual({
      paidAmountMinor: 0,
      balanceDueMinor: 10_000,
      paymentStatus: PaymentStatus.UNPAID,
    });

    expect(computePaymentStateAfterPayment({
      totalAmountMinor: 10_000,
      currentPaidAmountMinor: 0,
      paymentAmountMinor: 4_000,
    })).toEqual({
      paidAmountMinor: 4_000,
      balanceDueMinor: 6_000,
      paymentStatus: PaymentStatus.PARTIAL,
    });

    expect(computePaymentStateAfterPayment({
      totalAmountMinor: 10_000,
      currentPaidAmountMinor: 4_000,
      paymentAmountMinor: 6_000,
    })).toEqual({
      paidAmountMinor: 10_000,
      balanceDueMinor: 0,
      paymentStatus: PaymentStatus.PAID,
    });
  });

  it("keeps an explicit status while recomputing the balance", () => {
    expect(computeOrderPaymentState({
      totalAmountMinor: 10_000,
      paidAmountMinor: 7_500,
      paymentStatus: PaymentStatus.PARTIAL,
    })).toEqual({
      paidAmountMinor: 7_500,
      balanceDueMinor: 2_500,
      paymentStatus: PaymentStatus.PARTIAL,
    });
  });
});
