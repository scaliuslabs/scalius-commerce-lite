import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { storefrontSourcePath } from "./test-source-paths";

describe("phone country policy boundaries", () => {
  const phoneFieldSource = readFileSync(
    storefrontSourcePath("components", "PhoneField.tsx"),
    "utf8",
  );
  const authModalSource = readFileSync(
    storefrontSourcePath("components", "AuthModal.tsx"),
    "utf8",
  );
  const cartSource = readFileSync(storefrontSourcePath("pages", "cart.astro"), "utf8");

  it("removes the unrestricted selector option and locks calling codes under policy", () => {
    for (const source of [phoneFieldSource, authModalSource]) {
      expect(source).toContain("addInternationalOption={!hasActiveCountryPolicy}");
      expect(source).toContain("countryCallingCodeEditable={!hasActiveCountryPolicy}");
    }
  });

  it("keeps the checkout field mobile-operable and exposes inline errors", () => {
    expect(phoneFieldSource).toContain("flex h-[46px] w-full");
    expect(phoneFieldSource).toContain("md:h-9");
    expect(phoneFieldSource).not.toContain("min-h-11");
    expect(phoneFieldSource).not.toContain("py-1 text-sm");
    expect(phoneFieldSource).toContain('role="alert"');
    expect(phoneFieldSource).toContain("required={required}");
  });

  it("validates before either checkout flow leaves the cart", () => {
    expect(cartSource).toContain("validateStorefrontPhone(");
    expect(cartSource).toContain('new CustomEvent("phone-validation-error"');
    expect(cartSource.indexOf("const phoneValidation = validateStorefrontPhone(")).toBeLessThan(
      cartSource.indexOf("if (!codOnly)"),
    );
  });
});
