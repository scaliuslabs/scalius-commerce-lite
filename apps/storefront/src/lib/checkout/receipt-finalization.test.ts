import { describe, expect, it } from "vitest";

import { resolveCheckoutReceiptCleanup } from "./receipt-finalization";

describe("checkout receipt cleanup", () => {
  it("clears only the exact accepted checkout", () => {
    expect(resolveCheckoutReceiptCleanup({
      receiptState: "order_placed",
      recoveryMatchesOrder: true,
      recoveryMatchesCheckout: true,
      acceptedCheckout: true,
    })).toEqual({
      clearCart: true,
      clearCheckoutSession: true,
      clearCheckoutAttemptPreservingDraft: false,
      clearRecoveryPointer: true,
    });
  });

  it("clears an exact COD-only checkout without requiring a hosted-payment pointer", () => {
    expect(resolveCheckoutReceiptCleanup({
      receiptState: "order_placed",
      recoveryMatchesOrder: false,
      recoveryMatchesCheckout: false,
      directCheckoutMatches: true,
      acceptedCheckout: true,
    })).toEqual({
      clearCart: true,
      clearCheckoutSession: true,
      clearCheckoutAttemptPreservingDraft: false,
      clearRecoveryPointer: false,
    });
  });

  it.each([
    { label: "a different cart", recoveryMatchesCheckout: false },
    { label: "an identical new cart with a different checkout id", recoveryMatchesCheckout: false },
    { label: "an old receipt after a new draft", recoveryMatchesCheckout: false },
  ])("preserves $label while releasing the settled recovery pointer", ({ recoveryMatchesCheckout }) => {
    expect(resolveCheckoutReceiptCleanup({
      receiptState: "order_placed",
      recoveryMatchesOrder: true,
      recoveryMatchesCheckout,
      acceptedCheckout: true,
    })).toEqual({
      clearCart: false,
      clearCheckoutSession: false,
      clearCheckoutAttemptPreservingDraft: false,
      clearRecoveryPointer: true,
    });
  });

  it("keeps recovery and buyer input while payment can still change", () => {
    for (const receiptState of ["payment_pending", "payment_issue"]) {
      expect(resolveCheckoutReceiptCleanup({
        receiptState,
        recoveryMatchesOrder: true,
        recoveryMatchesCheckout: true,
        acceptedCheckout: false,
      })).toEqual({
        clearCart: false,
        clearCheckoutSession: false,
        clearCheckoutAttemptPreservingDraft: false,
        clearRecoveryPointer: false,
      });
    }
  });

  it("ends a cancelled checkout without deleting its form draft or cart", () => {
    expect(resolveCheckoutReceiptCleanup({
      receiptState: "order_updated",
      recoveryMatchesOrder: true,
      recoveryMatchesCheckout: true,
      acceptedCheckout: false,
    })).toEqual({
      clearCart: false,
      clearCheckoutSession: false,
      clearCheckoutAttemptPreservingDraft: true,
      clearRecoveryPointer: true,
    });
  });

  it("never lets an unrelated receipt change the active checkout", () => {
    expect(resolveCheckoutReceiptCleanup({
      receiptState: "order_placed",
      recoveryMatchesOrder: false,
      recoveryMatchesCheckout: true,
      acceptedCheckout: true,
    })).toEqual({
      clearCart: false,
      clearCheckoutSession: false,
      clearCheckoutAttemptPreservingDraft: false,
      clearRecoveryPointer: false,
    });
  });
});
