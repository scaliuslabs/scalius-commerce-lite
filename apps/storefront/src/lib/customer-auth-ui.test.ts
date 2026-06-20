import { describe, expect, it } from "vitest";

import {
  getCustomerAuthAlternateIntent,
  getCustomerAuthAlternateIntentLabel,
  getCustomerAuthInputError,
  resolveCustomerAuthUi,
} from "./customer-auth-ui";

describe("customer auth UI policy", () => {
  it("renders Email/SMS tabs for legacy both mode", () => {
    const ui = resolveCustomerAuthUi("both", "sms");

    expect(ui.showMethodSwitcher).toBe(true);
    expect(ui.requestOptions.map((option) => option.label)).toEqual(["Email", "SMS"]);
    expect(ui.currentOption.destinationLabel).toBe("Phone number");
  });

  it("normalizes legacy phone to SMS-only UI", () => {
    const ui = resolveCustomerAuthUi("phone");

    expect(ui.authMethod).toBe("sms_otp");
    expect(ui.showMethodSwitcher).toBe(false);
    expect(ui.currentOption).toMatchObject({
      method: "phone",
      channel: "sms",
      destinationLabel: "Phone number",
    });
  });

  it("normalizes unsupported email_phone_mandatory to email UI", () => {
    const ui = resolveCustomerAuthUi("email_phone_mandatory", "sms");

    expect(ui.authMethod).toBe("email");
    expect(ui.otpChannel).toBe("email");
    expect(ui.currentOption.destinationLabel).toBe("Email address");
  });

  it("supports independent collection and verification choices", () => {
    const ui = resolveCustomerAuthUi({
      otpChannels: ["email", "sms", "whatsapp"],
      requiredContactFields: ["email", "phone"],
      optionalContactFields: [],
      defaultOtpChannel: "whatsapp",
    });

    expect(ui.currentOption.channel).toBe("whatsapp");
    expect(ui.requestOptions.map((option) => option.label)).toEqual(["Email", "SMS", "WhatsApp"]);
    expect(ui.fields.email).toMatchObject({ visible: true, required: true, primary: false });
    expect(ui.fields.phone).toMatchObject({ visible: true, required: true, primary: true });
  });

  it("validates email OTP with phone collected for account creation", () => {
    expect(resolveCustomerAuthUi("email", "email", "sign_in").fields.phone.visible).toBe(false);
    expect(resolveCustomerAuthUi("email", "email", "sign_up").fields.phone).toMatchObject({
      visible: true,
      required: true,
      primary: false,
    });

    expect(getCustomerAuthInputError({
      authPolicy: "email",
      otpChannel: "email",
      intent: "sign_up",
      identifier: "buyer@example.com",
      phoneInput: "+8801712345678",
    })).toBeNull();

    expect(getCustomerAuthInputError({
      authPolicy: "email",
      otpChannel: "email",
      intent: "sign_up",
      identifier: "buyer@example.com",
    })).toBe("Enter a valid phone number for account creation.");

    expect(getCustomerAuthInputError({
      authPolicy: "email",
      otpChannel: "email",
      intent: "sign_in",
      identifier: "buyer@example.com",
    })).toBeNull();
  });

  it("validates optional email on phone OTP while phone remains primary", () => {
    expect(getCustomerAuthInputError({
      authPolicy: "whatsapp_otp",
      otpChannel: "whatsapp",
      identifier: "+8801712345678",
      emailInput: "",
    })).toBeNull();

    expect(getCustomerAuthInputError({
      authPolicy: "sms_otp",
      otpChannel: "sms",
      identifier: "+8801712345678",
      emailInput: "not-an-email",
    })).toBe("Enter a valid email address, or leave it blank.");
  });

  it("maps post-OTP intent errors to safe alternate actions", () => {
    expect(getCustomerAuthAlternateIntent("An account already exists for this phone number. Sign in instead.")).toBe("sign_in");
    expect(getCustomerAuthAlternateIntent("No account was found for this email. Create an account instead.")).toBe("sign_up");
    expect(getCustomerAuthAlternateIntent("Incorrect code. Please try again.")).toBeNull();
    expect(getCustomerAuthAlternateIntentLabel("sign_in")).toBe("Sign in with this contact");
    expect(getCustomerAuthAlternateIntentLabel("sign_up")).toBe("Create an account with this contact");
  });
});
