import { describe, expect, it } from "vitest";

import { giftCardLineDeliveryMarkup, readLineGiftCards } from "./gift-card-line-delivery";
import type { OrderLine } from "@/lib/order-line-extras";

function line(giftCards: unknown): OrderLine {
  return {
    id: "item_1",
    productId: "prod_gc",
    variantId: "var_gc",
    quantity: 2,
    productName: "Gift card",
    extras: { giftCards: giftCards as never },
  };
}

const sentToFriend = {
  giftCardId: "gc_1",
  last4: "7K2Q",
  initialAmount: 500,
  initialAmountMinor: 50_000,
  currencyCode: "BDT",
  sentTo: "r•••@gmail.com",
};
const sentToBuyer = { ...sentToFriend, giftCardId: "gc_2", last4: "9XYZ", sentTo: null };

describe("gift cards a line issued", () => {
  it("shows last 4, value and where each card went, never a code", () => {
    const markup = giftCardLineDeliveryMarkup(line([sentToFriend, sentToBuyer]), { orderId: "ord_1", access: "receipt" });
    expect(markup).toContain("Gift card •••• 7K2Q · ৳500");
    expect(markup).toContain("Sent to r•••@gmail.com");
    expect(markup).toContain("Sent to you");
    expect(markup).not.toContain("gc_1");
    // Guests have no "Show code"; the code went by email or SMS.
    expect(markup).not.toContain("/account/gift-cards");
  });

  it("points the account owner to Show code for a card that came to them", () => {
    expect(giftCardLineDeliveryMarkup(line([sentToBuyer]), { orderId: "ord_1", access: "account" }))
      .toContain('href="/account/gift-cards"');
    expect(giftCardLineDeliveryMarkup(line([sentToFriend]), { orderId: "ord_1", access: "account" }))
      .not.toContain("/account/gift-cards");
  });

  it("escapes the contact and renders nothing without cards", () => {
    const markup = giftCardLineDeliveryMarkup(line([{ ...sentToFriend, sentTo: "<img src=x>" }]), { orderId: "o", access: "receipt" });
    expect(markup).not.toContain("<img");
    expect(giftCardLineDeliveryMarkup(line(undefined), { orderId: "o", access: "receipt" })).toBe("");
    expect(readLineGiftCards([{ ...sentToFriend, last4: "bad!" }, "junk"])).toEqual([]);
  });
});
