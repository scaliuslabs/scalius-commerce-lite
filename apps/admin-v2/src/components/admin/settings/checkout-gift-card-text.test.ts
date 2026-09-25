import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_LANGUAGE_KEYS } from "@scalius/shared/checkout-language";
import { checkoutMessages } from "~/i18n/settings-checkout";

vi.mock("@scalius/api-client/sdk", () => ({}));

import { GIFT_CARD_TEXT_FIELDS } from "./CheckoutSettings";

describe("checkout text: gift cards", () => {
  it("lets merchants edit every gift-card and amount-due checkout string, with a label in both languages", () => {
    // The receipt's line-group title (orderLineGroupGiftCardText) sits with the other groups, not the tender copy.
    const tenderKeys = CHECKOUT_LANGUAGE_KEYS.filter((key) =>
      /^(giftCard|paidWithGiftCard|amountDue)/.test(key));
    expect([...GIFT_CARD_TEXT_FIELDS].sort()).toEqual([...tenderKeys].sort());
    for (const key of GIFT_CARD_TEXT_FIELDS) {
      expect(checkoutMessages.en[key]).toBeTruthy();
      expect(checkoutMessages.bn[key]).toBeTruthy();
    }
  });
});
