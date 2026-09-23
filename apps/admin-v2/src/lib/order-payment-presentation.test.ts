import { describe, expect, it } from "vitest";
import { buildOrderPaymentPresentation } from "./order-payment-presentation";

describe("order payment presentation", () => {
  it("closes collection on a cancelled order", () => {
    expect(buildOrderPaymentPresentation({ orderStatus: "cancelled", balanceDue: 950 }))
      .toEqual({ collectionClosed: true, amountDue: 0 });
  });

  it("keeps an active unpaid COD balance actionable", () => {
    expect(buildOrderPaymentPresentation({ orderStatus: "pending", balanceDue: 950 }))
      .toEqual({ collectionClosed: false, amountDue: 950 });
  });

  it("never shows a negative or unreadable balance", () => {
    expect(buildOrderPaymentPresentation({ orderStatus: "shipped", balanceDue: -5 }).amountDue).toBe(0);
    expect(buildOrderPaymentPresentation({ orderStatus: "shipped", balanceDue: Number.NaN }).amountDue).toBe(0);
  });
});
