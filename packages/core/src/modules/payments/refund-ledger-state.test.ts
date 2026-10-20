// The order's payment state after a refund, from its payment ledger: a
// refund never erases what a part-paid invoice still owes.
import { describe, expect, it } from "vitest";
import { computePaymentStateFromLedger } from "./refund-service";

const captured = (amountMinor: number) => ({ paymentType: "balance", status: "succeeded", amountMinor });
const refunded = (amountMinor: number) => ({ paymentType: "refund", status: "refunded", amountMinor });

describe("payment state after a refund", () => {
  it("keeps a part-paid invoice owing the rest when its recorded money is refunded", () => {
    // An invoice of 100 with 60 recorded; the 60 is given back.
    expect(computePaymentStateFromLedger({ totalAmountMinor: 10_000, payments: [captured(6_000), refunded(6_000)], paymentTermsDays: 30 }))
      .toEqual({ isFullRefund: false, paidAmountMinor: 0, balanceDueMinor: 10_000, paymentStatus: "unpaid" });
    // Part of it given back: the balance grows by what was returned.
    expect(computePaymentStateFromLedger({ totalAmountMinor: 10_000, payments: [captured(6_000), refunded(1_000)], paymentTermsDays: 30 }))
      .toEqual({ isFullRefund: false, paidAmountMinor: 5_000, balanceDueMinor: 5_000, paymentStatus: "partial" });
  });

  it("refunds a fully paid invoice, and any other order, as before", () => {
    expect(computePaymentStateFromLedger({ totalAmountMinor: 10_000, payments: [captured(10_000), refunded(10_000)], paymentTermsDays: 30 }))
      .toMatchObject({ isFullRefund: true, balanceDueMinor: 0, paymentStatus: "refunded" });
    // A deposit order (no terms) refunded in full closes, as it always has.
    expect(computePaymentStateFromLedger({ totalAmountMinor: 10_000, payments: [captured(6_000), refunded(6_000)], paymentTermsDays: null }))
      .toMatchObject({ isFullRefund: true, balanceDueMinor: 0, paymentStatus: "refunded" });
  });
});
