import { describe, expect, it } from "vitest";
import { checkoutAttemptRecoveryHref } from "./attempt-recovery";

describe("checkout conflict referral", () => {
  it("links to a proof-gated receipt and discards any supplied URL or bearer", () => {
    expect(checkoutAttemptRecoveryHref({
      orderId: "order_previous", paymentMethod: "scalius.bkash:bkash",
      href: "https://elsewhere.test", receiptToken: "chk_private",
    })).toBe("/order-success?orderId=order_previous&payment=scalius.bkash%3Abkash");
    expect(checkoutAttemptRecoveryHref({ orderId: "order_previous", paymentMethod: null }))
      .toBe("/order-success?orderId=order_previous");
  });
  it.each([null, [], {}, { orderId: "../private" }, { orderId: "a&token=secret" },
    { orderId: "safe", paymentMethod: "//elsewhere.test" }])("rejects malformed references %j", (details) => {
    expect(checkoutAttemptRecoveryHref(details)).toBeNull();
  });
});
