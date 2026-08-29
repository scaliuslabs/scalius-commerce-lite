import { describe, expect, it } from "vitest";

import {
  getCheckoutErrorMessage,
  getCheckoutStatusErrorMessage,
} from "./error-messages";
import { BANGLA_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";

describe("checkout error messages", () => {
  it("keeps specific backend messages", () => {
    expect(getCheckoutErrorMessage({
      error: {
        message: "Cotton Panjabi is no longer available.",
      },
    })).toBe("Cotton Panjabi is no longer available.");
  });

  it.each<[number, string, string]>([
    [401, "Order creation failed (401)", "Your sign-in session expired. Please sign in again or continue as a guest."],
    [409, "Order creation failed (409)", "This checkout was already submitted or changed in another tab. Please review your cart and try again."],
    [429, "Payment failed", "Too many checkout attempts. Please wait a moment and try again."],
    [503, "Order creation failed", "Checkout is temporarily unavailable. Please try again shortly."],
  ])("uses buyer-safe fallback copy for generic status %s errors", (
    status,
    fallback,
    expected,
  ) => {
    expect(getCheckoutStatusErrorMessage(status, fallback)).toBe(expected);
  });

  it("does not replace useful backend copy with generic status copy", () => {
    expect(getCheckoutStatusErrorMessage(
      429,
      "Too many checkout attempts. Please wait before trying again.",
    )).toBe("Too many checkout attempts. Please wait before trying again.");
  });

  it("uses active checkout copy for generic status failures", () => {
    expect(getCheckoutStatusErrorMessage(
      429,
      BANGLA_CHECKOUT_LANGUAGE_DATA.paymentFailedText,
      BANGLA_CHECKOUT_LANGUAGE_DATA,
    )).toBe(BANGLA_CHECKOUT_LANGUAGE_DATA.tooManyCheckoutAttemptsText);
  });
});
