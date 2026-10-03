import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_LANGUAGE_KEYS, CHECKOUT_LANGUAGE_LONG_TEXT_KEYS } from "@scalius/shared/checkout-language";
import { checkoutMessages } from "~/i18n/settings-checkout";

vi.mock("@scalius/api-client/sdk", () => ({}));

import { APP_TEXT_FIELDS, GIFT_CARD_TEXT_FIELDS } from "./CheckoutSettings";

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

describe("checkout text: apps at checkout", () => {
  it("lets merchants edit what buyers read when an app can't answer or its offer changed, labelled and explained in both languages", () => {
    const appKeys = CHECKOUT_LANGUAGE_KEYS.filter((key) => key.startsWith("checkoutApp"));
    expect([...APP_TEXT_FIELDS].sort()).toEqual([...appKeys].sort());
    for (const key of APP_TEXT_FIELDS) {
      // Sentences, so the editor gives them a text area.
      expect(CHECKOUT_LANGUAGE_LONG_TEXT_KEYS.has(key)).toBe(true);
      for (const label of [key, `${key}Help`] as const) {
        expect(checkoutMessages.en[label]).toBeTruthy();
        expect(checkoutMessages.bn[label]).toBeTruthy();
      }
    }
    expect(checkoutMessages.en.appTextTitle).toBe("Apps at checkout");
    expect(checkoutMessages.bn.appTextTitle).toBeTruthy();
  });
});
