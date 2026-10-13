import { describe, expect, it } from "vitest";
import { buildOtpDelivery } from "./otp-transport";

describe("OTP delivery reference", () => {
  it.each(["email", "sms", "whatsapp"] as const)("a %s code carries references only", (channel) => {
    const delivery = buildOtpDelivery({
      channel,
      purpose: "customer_login",
      challengeKey: "cust_otp:challenge_hash_1",
      deliveryKey: "otp_delivery_1",
    });
    expect(delivery).toEqual({
      purpose: "customer_login",
      challengeKey: "cust_otp:challenge_hash_1",
      deliveryKey: "otp_delivery_1",
      channel,
    });
  });
});
