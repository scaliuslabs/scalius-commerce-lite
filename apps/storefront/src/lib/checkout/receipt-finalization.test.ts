// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  addToCart,
  cartStore,
  clearCart,
  createCartItemKey,
  hydrateCartFromStorage,
} from "@/store/cart";
import {
  finalizeCheckoutReceipt,
  readLastPlacedOrderId,
  rememberSubmittedCart,
  resolveCheckoutReceiptCleanup,
} from "./receipt-finalization";
import {
  hashCheckoutCartFingerprint,
  readCheckoutFormDraft,
  writeCheckoutFormDraft,
} from "./session-state";

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

describe("finalizeCheckoutReceipt", () => {
  function receipt(orderId: string, checkoutId: string, cartHash: string): HTMLElement {
    const element = document.createElement("div");
    element.dataset.orderSuccessState = "order_placed";
    element.dataset.orderId = orderId;
    element.dataset.checkoutCartFinalize = "true";
    element.dataset.checkoutFinalizeId = checkoutId;
    element.dataset.checkoutFinalizeCartHash = cartHash;
    return element;
  }

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    hydrateCartFromStorage();
    clearCart();
  });

  it("takes only the ordered lines out when another tab added items meanwhile", async () => {
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    const submitted = JSON.stringify(cartStore.get().items);
    rememberSubmittedCart(submitted);
    sessionStorage.setItem("checkoutId", "chk_session_a");
    writeCheckoutFormDraft({ customerName: "Buyer", notes: "Call first" });
    // The second tab adds a cap after this tab submitted the tee.
    await addToCart({ id: "cap", variantId: "cap_1", name: "Cap", price: 200 });

    await finalizeCheckoutReceipt(receipt("ORDER1", "chk_session_a", (await hashCheckoutCartFingerprint(submitted))!));

    expect(Object.keys(cartStore.get().items)).toEqual([createCartItemKey({ id: "cap", variantId: "cap_1" })]);
    expect(readCheckoutFormDraft()).toBeNull();
    expect(readLastPlacedOrderId()).toBe("ORDER1");
  });

  it("leaves the cart alone when this tab did not submit the order", async () => {
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    await finalizeCheckoutReceipt(receipt("ORDER2", "chk_session_other", "cartfp_x"));
    expect(cartStore.get().totalItems).toBe(1);
    expect(readLastPlacedOrderId()).toBeNull();
  });
});
