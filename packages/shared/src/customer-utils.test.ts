import { describe, expect, it } from "vitest";

import {
  acceptedPhoneCountryPolicy,
  assertPhoneCountryAllowed,
  calculateCustomerStats,
  normalizePhoneCountryPolicy,
  phoneNumberSchema,
  validateAndFormatPhone,
} from "./customer-utils";

describe("customer commerce stats", () => {
  it("counts orders and normalizes Unix seconds", () => {
    expect(calculateCustomerStats([
      { createdAt: 1_700_000_000 },
      { createdAt: new Date("2024-01-01T00:00:00.000Z") },
      { createdAt: 1_800_000_000_000 },
    ])).toEqual({
      totalOrders: 3,
      lastOrderAt: new Date(1_800_000_000_000),
    });
  });
});

describe("accepted phone countries (merchant policy united with the market countries)", () => {
  it("adds every market country to an include list and keeps the merchant's order", () => {
    expect(acceptedPhoneCountryPolicy({ countries: ["AE", "BD"], mode: "include" }, ["BD", "IN"])).toEqual({
      countries: ["AE", "BD", "IN"],
      mode: "include",
    });
  });

  it("takes a market country out of an exclude list", () => {
    expect(acceptedPhoneCountryPolicy({ countries: ["IN", "US"], mode: "exclude" }, ["BD", "IN"])).toEqual({
      countries: ["US"],
      mode: "exclude",
    });
    // Every excluded country is sold to: nothing is left to refuse.
    expect(acceptedPhoneCountryPolicy({ countries: ["IN"], mode: "exclude" }, ["IN"])).toEqual({ countries: [], mode: "exclude" });
  });

  it("leaves an unrestricted policy and a store without market countries as they are", () => {
    expect(acceptedPhoneCountryPolicy({ countries: [], mode: "include" }, ["IN"])).toEqual({ countries: [], mode: "include" });
    expect(acceptedPhoneCountryPolicy({ countries: ["BD"], mode: "include" }, undefined)).toEqual({ countries: ["BD"], mode: "include" });
    expect(acceptedPhoneCountryPolicy(["BD"], [])).toEqual({ countries: ["BD"], mode: "include" });
  });

  it("is the same list for a Bangladesh-only store whose policy names Bangladesh", () => {
    expect(acceptedPhoneCountryPolicy({ countries: ["BD"], mode: "include" }, ["BD"])).toEqual({ countries: ["BD"], mode: "include" });
  });

  it("accepts an Indian mobile number once a market sells to India, and still refuses a country no market sells to", () => {
    const policy = acceptedPhoneCountryPolicy({ countries: ["BD"], mode: "include" }, ["BD", "IN"]);
    expect(validateAndFormatPhone("+919876543210", policy)).toBe("+919876543210");
    expect(validateAndFormatPhone("098765 43210", policy, { defaultCountry: "IN" })).toBe("+919876543210");
    expect(() => validateAndFormatPhone("+14155552671", policy)).toThrow("Phone numbers from US are not accepted");
  });
});

describe("phone country policy", () => {
  it("keeps empty country policies unrestricted", () => {
    expect(validateAndFormatPhone("+14155552671", { countries: [], mode: "include" })).toBe("+14155552671");
    expect(validateAndFormatPhone("+8801712345678", { countries: [], mode: "exclude" })).toBe("+8801712345678");
  });

  it("allows only configured countries in include mode", () => {
    expect(validateAndFormatPhone("+8801712345678", { countries: ["BD"], mode: "include" })).toBe("+8801712345678");
    expect(() => validateAndFormatPhone("+14155552671", { countries: ["BD"], mode: "include" })).toThrow(
      "Phone numbers from US are not accepted",
    );
  });

  it("rejects configured countries in exclude mode", () => {
    expect(validateAndFormatPhone("+8801712345678", { countries: ["US"], mode: "exclude" })).toBe("+8801712345678");
    expect(() => assertPhoneCountryAllowed("+14155552671", { countries: ["US"], mode: "exclude" })).toThrow(
      "Phone numbers from US are not accepted",
    );
  });

  it("keeps the existing array shortcut as include mode", () => {
    expect(validateAndFormatPhone("+8801712345678", ["BD"])).toBe("+8801712345678");
    expect(() => validateAndFormatPhone("+14155552671", ["BD"])).toThrow(
      "Phone numbers from US are not accepted",
    );
  });

  it("normalizes configured country codes before evaluation", () => {
    expect(normalizePhoneCountryPolicy({ countries: [" bd ", "BD", "bad"], mode: "exclude" })).toEqual({
      countries: ["BD"],
      mode: "exclude",
    });
  });

  it("reports invalid input as a schema issue instead of throwing from the transform", () => {
    expect(() => phoneNumberSchema.safeParse("01200000000")).not.toThrow();
    const invalid = phoneNumberSchema.safeParse("01200000000");
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues[0]?.message).toBe("Enter a valid phone number");
    }
    expect(phoneNumberSchema.parse("+8801712345678")).toBe("+8801712345678");
  });
});
