import { describe, expect, it } from "vitest";
import type { SiteSettings } from "@scalius/database/schema";
import { EmailOtpTransport, SmsOtpTransport, WhatsAppOtpTransport } from "./otp-transport";

const baseSettings = {
  authVerificationMethod: "email",
  whatsappAccessToken: "wa_token",
  whatsappPhoneNumberId: "phone_id_1",
  whatsappTemplateName: "auth_otp",
} as SiteSettings;

describe("OTP transports", () => {
  it("includes durable delivery metadata in email payloads", () => {
    const payload = new EmailOtpTransport().buildQueuePayload(
      "123456",
      "buyer@example.com",
      "Buyer",
      baseSettings,
      "email",
      "otp_delivery_1",
      4_102_444_800,
    );

    expect(payload).toMatchObject({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_1",
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "email",
      identifier: "buyer@example.com",
    });
  });

  it("includes durable delivery metadata in SMS payloads", () => {
    const payload = new SmsOtpTransport().buildQueuePayload(
      "123456",
      "+8801712345678",
      "Buyer",
      { ...baseSettings, authVerificationMethod: "sms_otp" } as SiteSettings,
      "sms",
      "otp_delivery_sms_1",
      4_102_444_800,
    );

    expect(payload).toMatchObject({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_sms_1",
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "sms_otp",
    });
  });

  it("includes durable metadata without WhatsApp credentials in WhatsApp payloads", () => {
    const payload = new WhatsAppOtpTransport().buildQueuePayload(
      "123456",
      "+8801712345678",
      "Buyer",
      { ...baseSettings, authVerificationMethod: "whatsapp_otp" } as SiteSettings,
      "whatsapp",
      "otp_delivery_wa_1",
      4_102_444_800,
    );

    expect(payload).toMatchObject({
      type: "auth.send_otp",
      deliveryKey: "otp_delivery_wa_1",
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method: "phone",
      allowedMethod: "whatsapp_otp",
    });
    expect(payload).not.toHaveProperty("waToken");
    expect(payload).not.toHaveProperty("waPhoneId");
    expect(payload).not.toHaveProperty("waTemplate");
  });
});
