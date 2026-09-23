import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { storefrontSourcePath } from "./test-source-paths";

describe("phone country policy boundaries", () => {
  const authModalSource = readFileSync(
    storefrontSourcePath("components", "AuthModal.tsx"),
    "utf8",
  );

  it("removes the unrestricted selector option and locks calling codes under policy", () => {
    expect(authModalSource).toContain("addInternationalOption={!hasActiveCountryPolicy}");
    expect(authModalSource).toContain("countryCallingCodeEditable={!hasActiveCountryPolicy}");
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
});
