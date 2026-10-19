import { describe, expect, it } from "vitest";
import { authenticatorAllowed, twoFactorMethodsForAccount } from "./authenticator-in-use";

describe("the authenticator follows the saved two-step method", () => {
  it("lets it in for the authenticator method or none saved, never for email codes", () => {
    expect(authenticatorAllowed("totp")).toBe(true);
    expect(authenticatorAllowed(null)).toBe(true);
    expect(authenticatorAllowed(undefined)).toBe(true);
    expect(authenticatorAllowed("email")).toBe(false);
  });

  it("offers the saved method first and drops a key an email-code account never used", () => {
    expect(twoFactorMethodsForAccount(["totp", "otp"], "email")).toEqual(["otp"]);
    expect(twoFactorMethodsForAccount(["otp", "totp"], "totp")).toEqual(["totp", "otp"]);
    expect(twoFactorMethodsForAccount(["totp", "otp"], null)).toEqual(["totp", "otp"]);
    expect(twoFactorMethodsForAccount(["otp"], "totp")).toEqual(["otp"]);
  });
});
