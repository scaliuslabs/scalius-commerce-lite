import { describe, expect, it } from "vitest";
import {
  normalizePolicyCountries,
  resolveSelectablePhoneCountries,
} from "./admin-phone-country-policy";

describe("admin phone-country policy", () => {
  it("normalizes include policy without an unrestricted International option", () => {
    const configured = normalizePolicyCountries({
      allowedCountries: ["bd", "AE", "US", "US", "bad"],
      allowedCountriesMode: "include",
    });

    expect(configured).toEqual(["BD", "AE", "US"]);
    expect(resolveSelectablePhoneCountries(configured, "include")).toEqual([
      "BD",
      "AE",
      "US",
    ]);
  });

  it("keeps a legacy saved country visible without widening new selections", () => {
    const configured = ["BD"] as const;

    expect(resolveSelectablePhoneCountries([...configured], "include", "+919876543210"))
      .toEqual(["BD", "IN"]);
    expect(resolveSelectablePhoneCountries([...configured], "include"))
      .toEqual(["BD"]);
  });
});
