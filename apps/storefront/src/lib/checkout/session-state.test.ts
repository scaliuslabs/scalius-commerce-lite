// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { clearCheckoutSession } from "./session-state";

describe("clearCheckoutSession", () => {
  it("removes checkout transfer state and legacy analytics PII keys", () => {
    const keys = [
      "scalius_checkout_data",
      "scalius_checkout_gateways",
      "checkoutId",
      "scalius_user_phone",
      "scalius_user_email",
      "scalius_user_name",
      "scalius_user_city",
    ];

    for (const key of keys) {
      sessionStorage.setItem(key, `${key}-value`);
    }

    clearCheckoutSession();

    for (const key of keys) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
  });
});
