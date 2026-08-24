import { describe, expect, it } from "vitest";

import { buildPaymentRecoveryUrl } from "./payment-recovery";

describe("hosted payment recovery URL", () => {
  it("does not call a normal provider Back navigation a failed payment", () => {
    expect(buildPaymentRecoveryUrl({
      orderId: "order_1",
      gateway: "sslcommerz",
    })).toBe("/order-success?orderId=order_1&payment=sslcommerz");
  });

  it("carries a failure result only after local session creation failed", () => {
    expect(buildPaymentRecoveryUrl({
      orderId: "order_1",
      gateway: "polar",
      paymentType: "deposit",
      depositAmount: 500,
      result: "failed",
    })).toBe("/order-success?orderId=order_1&payment=polar&result=failed&paymentType=deposit&depositAmount=500");
  });
});
