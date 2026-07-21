import { describe, expect, it } from "vitest";

import {
  hasActivePhoneCountryPolicy,
  validateStorefrontPhone,
} from "./phone-country-policy";

describe("storefront phone country policy", () => {
  const includePolicy = {
    countries: ["BD", "AE", "US"],
    mode: "include" as const,
  };

  it("accepts and normalizes a number from an allowed country", () => {
    expect(validateStorefrontPhone("+880 1712-345678", includePolicy)).toEqual({
      ok: true,
      value: "+8801712345678",
    });
  });

  it("rejects a valid number from a country outside the allow list", () => {
    expect(validateStorefrontPhone("+919876543210", includePolicy)).toEqual({
      ok: false,
      value: "+919876543210",
      message: "This store does not accept phone numbers from that country.",
    });
  });

  it("distinguishes missing and malformed values", () => {
    expect(validateStorefrontPhone("", includePolicy).message).toBe(
      "Enter your phone number.",
    );
    expect(validateStorefrontPhone("123", includePolicy).message).toBe(
      "Enter a valid phone number.",
    );
    expect(
      validateStorefrontPhone("", includePolicy, { required: false }),
    ).toEqual({ ok: true, value: "" });
  });

  it("treats an empty country selection as unrestricted", () => {
    expect(hasActivePhoneCountryPolicy({ countries: [], mode: "include" })).toBe(false);
    expect(validateStorefrontPhone("+919876543210", { countries: [] }).ok).toBe(true);
  });

  it("supports excluded-country policies", () => {
    expect(
      validateStorefrontPhone("+8801712345678", {
        countries: ["BD"],
        mode: "exclude",
      }).message,
    ).toBe("This store does not accept phone numbers from that country.");
  });
});
