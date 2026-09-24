import { describe, expect, it } from "vitest";

import { checkContact, checkNewAccount, formatWait, resolveCustomerAuthUi } from "./customer-auth-ui";

describe("customer sign-in UI model", () => {
  it("offers Email and Phone when the store enables both, and asks new buyers only for missing contacts", () => {
    const email = resolveCustomerAuthUi("both");
    expect(email.showMethodSwitcher).toBe(true);
    expect(email.requestMethod).toBe("email");
    expect(email.newAccount).toEqual({ phone: "required", email: "hidden" });

    const phone = resolveCustomerAuthUi("both", "sms");
    expect(phone.requestMethod).toBe("phone");
    expect(phone.newAccount).toEqual({ phone: "hidden", email: "optional" });
  });

  it("follows a store that requires email for phone sign-ups", () => {
    const ui = resolveCustomerAuthUi({
      otpChannels: ["sms"],
      requiredContactFields: ["email", "phone"],
      optionalContactFields: [],
      defaultOtpChannel: "sms",
    });
    expect(ui.showMethodSwitcher).toBe(false);
    expect(ui.newAccount).toEqual({ phone: "hidden", email: "required" });
    expect(checkNewAccount(ui, { name: "Rahim", phone: "", email: "" })).toEqual({
      ok: false, field: "email", message: "Enter your email address.",
    });
  });

  it("accepts Bangla digits and any spacing for phones, and explains bad input", () => {
    expect(checkContact("phone", "০১৭১২ ৩৪৫-৬৭৮")).toEqual({ ok: true, value: "+8801712345678" });
    expect(checkContact("phone", "0171")).toMatchObject({ ok: false, message: "Enter a Bangladeshi mobile number (01XXXXXXXXX)." });
    // 012… and landlines are not mobile numbers.
    expect(checkContact("phone", "01212345678")).toMatchObject({ ok: false, message: "Enter a Bangladeshi mobile number (01XXXXXXXXX)." });
    expect(checkContact("phone", "02123456789")).toMatchObject({ ok: false });
    expect(checkContact("email", " Buyer@Example.com ")).toEqual({ ok: true, value: "buyer@example.com" });
    expect(checkContact("email", "buyer@")).toMatchObject({ ok: false });
  });

  it("validates the new-account details for an email sign-up", () => {
    const ui = resolveCustomerAuthUi("email");
    expect(checkNewAccount(ui, { name: " ", phone: "01712345678", email: "" })).toMatchObject({ field: "name" });
    expect(checkNewAccount(ui, { name: "Rahim", phone: "", email: "" })).toMatchObject({ field: "phone" });
    expect(checkNewAccount(ui, { name: " Rahim ", phone: "01712-345678", email: "" })).toEqual({
      ok: true, account: { name: "Rahim", phone: "+8801712345678" },
    });
  });

  it("formats honest waits", () => {
    expect(formatWait(120)).toBe("2:00");
    expect(formatWait(45)).toBe("0:45");
    expect(formatWait(-3)).toBe("0:00");
  });
});
