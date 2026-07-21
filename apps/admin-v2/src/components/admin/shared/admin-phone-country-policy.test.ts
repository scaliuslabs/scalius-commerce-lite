import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("keeps the picker fail-closed until policy resolution and on read failure", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./AdminPhoneInput.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("if (policyQuery.isPending)");
    expect(source).toContain("if (policyQuery.isError)");
    expect(source).toContain("Retry country policy");
    expect(source).toContain("addInternationalOption={!hasActivePolicy}");
    expect(source).toContain("countryCallingCodeEditable={!hasActivePolicy}");
    expect(source).toContain('"flex h-11 w-full');
    expect(source).toContain("[&_.PhoneInputCountrySelect]:h-full");
    expect(source).toContain("[&_.PhoneInputInput]:h-full");
  });
});
