// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import {
  clearCheckoutSession,
  clearCheckoutTransferSession,
} from "./session-state";

const checkoutTransferKeys = [
  "scalius_checkout_data",
  "scalius_checkout_gateways",
] as const;

const legacyAnalyticsKeys = [
  "scalius_user_phone",
  "scalius_user_email",
  "scalius_user_name",
  "scalius_user_city",
] as const;

describe("checkout session state", () => {
  it("clears cart-to-checkout transfer state without rotating the active checkout id", () => {
    const keys = [
      ...checkoutTransferKeys,
      "checkoutId",
      ...legacyAnalyticsKeys,
    ];

    for (const key of keys) {
      sessionStorage.setItem(key, `${key}-value`);
    }

    clearCheckoutTransferSession();

    for (const key of [...checkoutTransferKeys, ...legacyAnalyticsKeys]) {
      expect(sessionStorage.getItem(key)).toBeNull();
    }
    expect(sessionStorage.getItem("checkoutId")).toBe("checkoutId-value");
  });

  it("removes checkout transfer state, active checkout id, and legacy analytics PII keys", () => {
    const keys = [
      ...checkoutTransferKeys,
      "checkoutId",
      ...legacyAnalyticsKeys,
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
