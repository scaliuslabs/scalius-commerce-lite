import { describe, expect, it } from "vitest";
import { buildOrderPaymentPresentation } from "./order-payment-presentation";

describe("order payment presentation", () => {
  it("closes collection without erasing cancelled-order audit facts", () => {
    expect(buildOrderPaymentPresentation({
      orderStatus: "cancelled",
      balanceDue: 950,
      codStatus: "pending",
    })).toEqual({
      collectionClosed: true,
      amountDue: 0,
      amountDueLabel: "No payment due",
      cashCollectionLabel: "Collection closed",
      recordedCodStatusLabel: "Pending",
    });
  });

  it("keeps an active unpaid COD balance actionable", () => {
    expect(buildOrderPaymentPresentation({
      orderStatus: "pending",
      balanceDue: 950,
      codStatus: "pending",
    })).toEqual({
      collectionClosed: false,
      amountDue: 950,
      amountDueLabel: "Balance due",
      cashCollectionLabel: "Pending",
      recordedCodStatusLabel: null,
    });
  });
});
