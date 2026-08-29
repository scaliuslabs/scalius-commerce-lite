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
    expect(phoneFieldSource).toContain("[&_.PhoneInputInput]:text-base");
    expect(phoneFieldSource).not.toContain("[&_.PhoneInputInput]:text-sm");
    expect(phoneFieldSource).toContain('new Intl.DisplayNames([languageCode], { type: "region" })');
    expect(phoneFieldSource).toContain("country: countrySelectLabel");
    expect(cartSource).toContain("countrySelectLabel={copy.phoneCountryLabelText}");
  });

  it("keeps account controls labelled, touch-sized, and iOS-zoom safe", () => {
    expect(authModalSource).toContain('aria-labelledby="customer-auth-title"');
    expect(authModalSource).toContain('aria-label="Close account dialog"');
    expect(authModalSource).toContain('className="flex h-11 w-11');
    expect(authModalSource).toContain('htmlFor="auth-primary-input"');
    expect(authModalSource).toContain('id="auth-primary-input"');
    expect(authModalSource).toContain('htmlFor="auth-phone-input"');
    expect(authModalSource).toContain('id="auth-phone-input"');
    expect(authModalSource).toContain("min-h-11 flex-1");
    expect(authModalSource).toContain("[&_.PhoneInputInput]:text-base");
  });

  it("validates before either checkout flow leaves the cart", () => {
    expect(cartSource).toContain("validateStorefrontPhone(");
    expect(cartSource).toContain('new CustomEvent("phone-validation-error"');
    expect(cartSource.indexOf("const phoneValidation = validateStorefrontPhone(")).toBeLessThan(
      cartSource.indexOf("if (!codOnly)"),
    );
  });
});
