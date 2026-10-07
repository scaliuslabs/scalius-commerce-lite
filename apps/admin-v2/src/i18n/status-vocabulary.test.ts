import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import { orderMessages, paymentStatusLabel } from "./orders";

// One vocabulary: an order's status words read the same in the dashboard, on
// the storefront's confirmation and in tracking. The storefront's checkout
// language data is the shared source; the dashboard catalog must say the same.
const PAIRS = [
  ["status.pending", "orderReceiptStatusPendingText"],
  ["status.confirmed", "orderReceiptStatusConfirmedText"],
  ["status.processing", "orderReceiptStatusProcessingText"],
  ["status.shipped", "orderReceiptStatusShippedText"],
  ["status.delivered", "orderReceiptStatusDeliveredText"],
  ["status.completed", "orderReceiptStatusCompletedText"],
  ["status.cancelled", "orderReceiptStatusCancelledText"],
  ["status.refunded", "orderReceiptStatusRefundedText"],
  ["status.returned", "orderReceiptStatusReturnedText"],
  ["status.incomplete", "orderReceiptStatusIncompleteText"],
  ["payment.paid", "orderReceiptPaymentStatusPaidText"],
  ["payment.partial", "orderReceiptPaymentStatusPartialText"],
  ["payment.unpaid", "orderReceiptPaymentStatusUnpaidText"],
  ["payment.partially_refunded", "orderReceiptStatusPartiallyRefundedText"],
  ["payment.dueOnDelivery", "dueOnDeliveryText"],
] as const;

describe("order and payment status words", () => {
  it.each(PAIRS)("%s reads as the storefront says it (English and Bangla)", (adminKey, sharedKey) => {
    expect(orderMessages.en[adminKey]).toBe(ENGLISH_CHECKOUT_LANGUAGE_DATA[sharedKey]);
    expect(orderMessages.bn[adminKey]).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA[sharedKey]);
  });

  it("calls an unpaid cash-on-delivery order Due on delivery, never Unpaid", () => {
    const t = (key: keyof typeof orderMessages.en) => orderMessages.en[key];
    expect(paymentStatusLabel(t, "unpaid", "cod")).toBe("Due on delivery");
    expect(paymentStatusLabel(t, "unpaid", "stripe")).toBe("Unpaid");
    expect(paymentStatusLabel(t, "unpaid")).toBe("Unpaid");
    expect(paymentStatusLabel(t, "partial", "cod")).toBe("Partially paid");
  });
});
