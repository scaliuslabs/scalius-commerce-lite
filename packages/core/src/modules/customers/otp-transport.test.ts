import { describe, expect, it } from "vitest";
import { buildOtpQueuePayload } from "./otp-transport";

describe("OTP queue payload", () => {
  it.each([
    ["email", "email", "email"],
    ["sms", "phone", "sms_otp"],
    ["whatsapp", "phone", "whatsapp_otp"],
  ] as const)("a %s code carries references only", (channel, method, allowedMethod) => {
    const payload = buildOtpQueuePayload({
      channel,
      purpose: "customer_login",
      challengeKey: "cust_otp:challenge_hash_1",
      deliveryKey: "otp_delivery_1",
      otpExpiresAt: 4_102_444_800,
    });
    expect(payload).toEqual({
      type: "auth.send_otp",
      challengeKey: "cust_otp:challenge_hash_1",
      deliveryKey: "otp_delivery_1",
      purpose: "customer_login",
      otpExpiresAt: 4_102_444_800,
      method,
      allowedMethod,
      channel,
    });
  });
});
