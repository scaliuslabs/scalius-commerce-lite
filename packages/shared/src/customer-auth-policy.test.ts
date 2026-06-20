import { describe, expect, it } from "vitest";

import {
  customerAuthMethodUsesEmailProvider,
  customerAuthMethodUsesSmsProvider,
  customerAuthMethodUsesWhatsAppProvider,
  customerAuthPolicyUsesEmailProvider,
  getCustomerAuthAllowedRequestMethods,
  getCustomerAuthDeliveryChannel,
  getDefaultCustomerAuthRequestMethod,
  getLegacyCustomerAuthMethodForPolicy,
  normalizeCustomerAuthMethod,
  normalizeCustomerAuthPolicy,
  resolveCustomerAuthPolicy,
  resolveCustomerAuthChannelForRequest,
} from "./customer-auth-policy";

describe("customer auth policy", () => {
  it.each([
    ["email", "email"],
    ["sms_otp", "sms_otp"],
    ["whatsapp_otp", "whatsapp_otp"],
    ["both", "both"],
    ["phone", "sms_otp"],
    ["email_phone_mandatory", "email"],
    ["unexpected", "email"],
    [null, "email"],
    [undefined, "email"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeCustomerAuthMethod(input)).toBe(expected);
  });

  it.each([
    ["email", ["email"], "email"],
    ["sms_otp", ["phone"], "phone"],
    ["whatsapp_otp", ["phone"], "phone"],
    ["both", ["email", "phone"], "email"],
    ["phone", ["phone"], "phone"],
  ] as const)("resolves request methods for %s", (input, requestMethods, defaultMethod) => {
    expect(getCustomerAuthAllowedRequestMethods(input)).toEqual(requestMethods);
    expect(getDefaultCustomerAuthRequestMethod(input)).toBe(defaultMethod);
  });

  it("separates email, SMS, and WhatsApp provider requirements", () => {
    expect(customerAuthMethodUsesEmailProvider("email")).toBe(true);
    expect(customerAuthMethodUsesEmailProvider("both")).toBe(true);
    expect(customerAuthMethodUsesEmailProvider("sms_otp")).toBe(false);
    expect(customerAuthMethodUsesSmsProvider("sms_otp")).toBe(true);
    expect(customerAuthMethodUsesSmsProvider("both")).toBe(true);
    expect(customerAuthMethodUsesSmsProvider("whatsapp_otp")).toBe(false);
    expect(customerAuthMethodUsesWhatsAppProvider("whatsapp_otp")).toBe(true);
    expect(customerAuthMethodUsesWhatsAppProvider("both")).toBe(false);
    expect(customerAuthPolicyUsesEmailProvider({
      otpChannels: ["email", "whatsapp"],
      requiredContactFields: ["phone"],
      optionalContactFields: [],
      defaultOtpChannel: "email",
    })).toBe(true);
  });

  it("labels the phone side of both as SMS, not WhatsApp", () => {
    const policy = resolveCustomerAuthPolicy("both");

    expect(policy.label).toBe("Email or SMS OTP");
    expect(policy.requestOptions).toEqual([
      expect.objectContaining({ method: "email", label: "Email", channel: "email" }),
      expect.objectContaining({ method: "phone", label: "SMS", channel: "sms" }),
    ]);
  });

  it.each([
    ["email", "email", "email"],
    ["both", "email", "email"],
    ["both", "phone", "sms"],
    ["sms_otp", "phone", "sms"],
    ["phone", "phone", "sms"],
    ["whatsapp_otp", "phone", "whatsapp"],
  ] as const)("resolves %s/%s to %s delivery", (authMethod, requestMethod, channel) => {
    expect(getCustomerAuthDeliveryChannel(authMethod, requestMethod)).toBe(channel);
  });

  it("normalizes advanced collection and verification policy", () => {
    const policy = normalizeCustomerAuthPolicy({
      otpChannels: ["email", "whatsapp"],
      requiredContactFields: ["email"],
      optionalContactFields: ["phone", "email"],
      defaultOtpChannel: "whatsapp",
    });

    expect(policy).toEqual({
      otpChannels: ["email", "whatsapp"],
      requiredContactFields: ["email", "phone"],
      optionalContactFields: [],
      defaultOtpChannel: "whatsapp",
    });
    expect(resolveCustomerAuthChannelForRequest(policy, "phone")).toBe("whatsapp");
    expect(resolveCustomerAuthChannelForRequest(policy, "email")).toBe("email");
  });

  it("keeps phone required even when only phone-based OTP channels are enabled", () => {
    const policy = normalizeCustomerAuthPolicy({
      otpChannels: ["sms", "whatsapp"],
      requiredContactFields: [],
      optionalContactFields: ["phone", "email"],
      defaultOtpChannel: "sms",
    });

    expect(policy).toEqual({
      otpChannels: ["sms", "whatsapp"],
      requiredContactFields: ["phone"],
      optionalContactFields: ["email"],
      defaultOtpChannel: "sms",
    });
  });

  it("resolves explicit phone channel selection when both SMS and WhatsApp are enabled", () => {
    const policy = normalizeCustomerAuthPolicy({
      otpChannels: ["sms", "whatsapp"],
      requiredContactFields: [],
      optionalContactFields: ["email"],
      defaultOtpChannel: "sms",
    });

    expect(resolveCustomerAuthChannelForRequest(policy, "phone", "whatsapp")).toBe("whatsapp");
    expect(resolveCustomerAuthChannelForRequest(policy, "phone")).toBe("sms");
    expect(getCustomerAuthDeliveryChannel(policy, "phone", "whatsapp")).toBe("whatsapp");
  });

  it("keeps a legacy auth method summary for clients that have not adopted the policy object", () => {
    expect(getLegacyCustomerAuthMethodForPolicy({
      otpChannels: ["email", "sms"],
      requiredContactFields: ["phone"],
      optionalContactFields: ["email"],
      defaultOtpChannel: "email",
    })).toBe("both");
    expect(getLegacyCustomerAuthMethodForPolicy({
      otpChannels: ["email", "whatsapp"],
      requiredContactFields: ["phone"],
      optionalContactFields: ["email"],
      defaultOtpChannel: "whatsapp",
    })).toBe("whatsapp_otp");
  });
});
