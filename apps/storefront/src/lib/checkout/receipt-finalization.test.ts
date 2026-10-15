// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { readBuyerAttributes, writeBuyerAttribute } from "@/lib/buyer-ui/state";

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
  readHostedPaymentRecoverySession,
  writeCheckoutFormDraft,
  writeHostedPaymentRecoverySession,
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
    writeBuyerAttribute("test.gift.message", "Ordered gift");
    // The second tab adds a cap after this tab submitted the tee.
    await addToCart({ id: "cap", variantId: "cap_1", name: "Cap", price: 200 });

    await finalizeCheckoutReceipt(receipt("ORDER1", "chk_session_a", (await hashCheckoutCartFingerprint(submitted))!));

    expect(Object.keys(cartStore.get().items)).toEqual([createCartItemKey({ id: "cap", variantId: "cap_1" })]);
    expect(readCheckoutFormDraft()).toBeNull();
    expect(readBuyerAttributes()).toEqual({});
    expect(readLastPlacedOrderId()).toBe("ORDER1");
  });

  it("leaves the cart alone when this tab did not submit the order", async () => {
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    await finalizeCheckoutReceipt(receipt("ORDER2", "chk_session_other", "cartfp_x"));
    expect(cartStore.get().totalItems).toBe(1);
    expect(readLastPlacedOrderId()).toBeNull();
  });

  it("uses the committed cart when a changed COD submit overwrote its snapshot before conflicting", async () => {
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    const original = JSON.stringify(cartStore.get().items);
    sessionStorage.setItem("checkoutId", "chk_session_a");
    rememberSubmittedCart(original);
    writeHostedPaymentRecoverySession("/order-success?orderId=ORDER1", {
      checkoutId: "chk_session_a", cartItems: original,
    }, "cod");
    // New shopping remains even though its rejected COD submit replaced the snapshot.
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    await addToCart({ id: "cap", variantId: "cap_1", name: "Cap", price: 200 });
    rememberSubmittedCart(JSON.stringify(cartStore.get().items));
    const element = receipt("ORDER1", "chk_session_a", (await hashCheckoutCartFingerprint(original))!);

    await finalizeCheckoutReceipt(element);

    expect(cartStore.get().items[createCartItemKey({ id: "tee", variantId: "tee_m" })]?.quantity).toBe(1);
    expect(cartStore.get().items[createCartItemKey({ id: "cap", variantId: "cap_1" })]?.quantity).toBe(1);
    expect(sessionStorage.getItem("checkoutId")).toBeNull();
    expect(readHostedPaymentRecoverySession()).toBeNull();
    expect(readLastPlacedOrderId()).toBe("ORDER1");
    await finalizeCheckoutReceipt(element);
    expect(cartStore.get().totalItems).toBe(2);
  });

  it("does not use an old recovery's quantities against a different active checkout", async () => {
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    const original = JSON.stringify(cartStore.get().items);
    writeHostedPaymentRecoverySession("/order-success?orderId=ORDER1", {
      checkoutId: "chk_session_old", cartItems: original,
    }, "cod");
    sessionStorage.setItem("checkoutId", "chk_session_new");
    rememberSubmittedCart(original);

    await finalizeCheckoutReceipt(receipt("ORDER1", "chk_session_old", (await hashCheckoutCartFingerprint(original))!));

    expect(cartStore.get().totalItems).toBe(1);
    expect(sessionStorage.getItem("checkoutId")).toBe("chk_session_new");
    expect(readHostedPaymentRecoverySession()).toBeNull();
    expect(readLastPlacedOrderId()).toBeNull();
  });

  it("does not remove cart lines from a malformed recovery fingerprint", async () => {
    await addToCart({ id: "tee", variantId: "tee_m", name: "Tee", price: 500 });
    sessionStorage.setItem("checkoutId", "chk_session_a");
    writeHostedPaymentRecoverySession("/order-success?orderId=ORDER1", {
      checkoutId: "chk_session_a", cartItems: JSON.stringify(cartStore.get().items),
    }, "cod");
    const recovery = readHostedPaymentRecoverySession()!;
    localStorage.setItem("scalius_hosted_payment_recovery", JSON.stringify({ ...recovery, cartFingerprint: "[null]" }));

    await finalizeCheckoutReceipt(receipt("ORDER1", "chk_session_a", "cartfp_unmatched"));

    expect(cartStore.get().totalItems).toBe(1);
    expect(sessionStorage.getItem("checkoutId")).toBeNull();
  });

  it("ends the matching attempt without changing the cart or draft when conflict recovery has no original lines", async () => {
    await addToCart({ id: "cap", variantId: "cap_1", name: "Cap", price: 200 });
    sessionStorage.setItem("checkoutId", "chk_session_a");
    writeCheckoutFormDraft({ customerName: "Buyer", notes: "New checkout draft" });
    writeBuyerAttribute("test.gift.message", "New gift");
    writeHostedPaymentRecoverySession("/order-success?orderId=ORDER1", { checkoutId: "chk_session_a" }, "cod");

    await finalizeCheckoutReceipt(receipt("ORDER1", "chk_session_a", "cartfp_unmatched"));

    expect(cartStore.get().totalItems).toBe(1);
    expect(sessionStorage.getItem("checkoutId")).toBeNull();
    expect(readHostedPaymentRecoverySession()).toBeNull();
    expect(readCheckoutFormDraft()).toEqual({ customerName: "Buyer", notes: "New checkout draft" });
    expect(readBuyerAttributes()).toEqual({ "test.gift.message": "New gift" });
  });

  it.each([
    { state: "order_placed", markerId: "chk_session_a", ended: true },
    { state: "order_updated", markerId: "chk_session_a", ended: true },
    { state: "payment_pending", markerId: "chk_session_a", ended: false },
    { state: "payment_issue", markerId: "chk_session_a", ended: false },
    { state: "order_placed", markerId: "chk_session_other", ended: false },
  ])("retires only a settled matching direct conflict attempt: $state / $markerId", async ({ state, markerId, ended }) => {
    await addToCart({ id: "cap", variantId: "cap_1", name: "Cap", price: 200 });
    sessionStorage.setItem("checkoutId", "chk_session_a");
    writeCheckoutFormDraft({ notes: "Keep my changed draft" });
    const element = receipt("ORDER1", markerId, "");
    delete element.dataset.checkoutFinalizeCartHash;
    element.dataset.orderSuccessState = state;

    await finalizeCheckoutReceipt(element);

    expect(sessionStorage.getItem("checkoutId")).toBe(ended ? null : "chk_session_a");
    expect(cartStore.get().totalItems).toBe(1);
    expect(readCheckoutFormDraft()).toEqual({ notes: "Keep my changed draft" });
  });
});
