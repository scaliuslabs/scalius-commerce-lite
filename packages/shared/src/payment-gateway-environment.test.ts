import { describe, expect, it } from "vitest";

import { getStripeCredentialEnvironment } from "./payment-gateway-environment";

describe("getStripeCredentialEnvironment", () => {
  it.each([
    [{ secretKey: "sk_test_value", publishableKey: "pk_test_value" }, "test"],
    [{ secretKey: "rk_live_value", publishableKey: "pk_live_value" }, "live"],
    [{ secretKey: "sk_test_value", publishableKey: "pk_live_value" }, "mixed"],
    [{ secretKey: "sk_live_value" }, "live"],
    [{ publishableKey: "pk_test_value" }, "test"],
    [{ secretKey: "not-a-stripe-key", publishableKey: "" }, "unknown"],
    [null, "unknown"],
  ] as const)("classifies %o as %s", (settings, expected) => {
    expect(getStripeCredentialEnvironment(settings)).toBe(expected);
  });
});
