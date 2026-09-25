import { describe, expect, it } from "vitest";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";
import { receiptLinkRecoveryState } from "./order-success-recovery";

describe("receipt link recovery", () => {
  it("answers a link without an order id with a friendly 404, not 400", () => {
    expect(receiptLinkRecoveryState({ requestedOrderId: "" }, copy)).toEqual({
      title: copy.orderReceiptIncompleteTitleText,
      message: copy.orderReceiptTrackOrderHelpText,
      status: 404,
      action: { href: "/track-order", label: copy.trackOrderText },
    });
  });

  it("answers an order this browser holds no receipt for with 404 and Track your order", () => {
    const state = receiptLinkRecoveryState({ requestedOrderId: "ord_elsewhere" }, copy);
    expect(state.status).toBe(404);
    expect(state.title).toBe(copy.orderReceiptMissingTitleText);
    expect(state.action.href).toBe("/track-order");
  });

  it("sends a returning hosted payment to verified recovery, still as 404", () => {
    const recoveryUrl = "/payment-recovery?orderId=ord_1&payment=sslcommerz&result=failed";
    const state = receiptLinkRecoveryState({ requestedOrderId: "ord_1", recoveryUrl }, copy);
    expect(state.status).toBe(404);
    expect(state.message).toBe(copy.orderReceiptBrowserRecoveryMessageText);
    expect(state.action).toEqual({ href: recoveryUrl, label: copy.orderReceiptVerifyRecoveryText });
  });
});
