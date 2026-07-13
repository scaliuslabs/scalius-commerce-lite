import { describe, expect, it } from "vitest";

import {
  checkoutFlowValuesEqual,
  rebaseCheckoutFlowDraft,
  type CheckoutFlowValues,
} from "./checkout-flow-draft";

const base: CheckoutFlowValues = {
  guestCheckoutEnabled: true,
  checkoutMode: "all",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
};

describe("checkout-flow conflict rebasing", () => {
  it("keeps local edits while adopting remote changes to untouched fields", () => {
    const rebased = rebaseCheckoutFlowDraft({
      base,
      local: { ...base, guestCheckoutEnabled: false },
      latest: {
        ...base,
        checkoutMode: "gateways_only",
        partialPaymentAmount: 250,
      },
    });

    expect(rebased).toEqual({
      guestCheckoutEnabled: false,
      checkoutMode: "gateways_only",
      partialPaymentEnabled: false,
      partialPaymentAmount: 250,
    });
  });

  it("prefers the merchant's local value for a field edited in both tabs", () => {
    const rebased = rebaseCheckoutFlowDraft({
      base,
      local: { ...base, checkoutMode: "guest_cod_only" },
      latest: { ...base, checkoutMode: "gateways_only" },
    });

    expect(rebased.checkoutMode).toBe("guest_cod_only");
    expect(checkoutFlowValuesEqual(rebased, base)).toBe(false);
  });
});
