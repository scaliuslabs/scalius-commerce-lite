import { describe, expect, it } from "vitest";

import {
  assertPhoneCountryAllowed,
  normalizePhoneCountryPolicy,
  validateAndFormatPhone,
} from "./customer-utils";

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
});
