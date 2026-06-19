import { describe, expect, it } from "vitest";
import {
  createAuthOtpDeliveryKey,
  createAuthOtpDeliveryTarget,
  createAuthOtpProviderClientReference,
  hashOtpIdentifier,
  maskOtpIdentifier,
} from "./otp-delivery-receipts";

describe("OTP delivery receipt helpers", () => {
  it("hashes identifiers case-insensitively and stores only masked recipients", async () => {
    const first = await hashOtpIdentifier("Buyer@Example.com");
    const second = await hashOtpIdentifier("buyer@example.com");
    const target = await createAuthOtpDeliveryTarget({
      deliveryKey: "otp_delivery_1",
      method: "email",
      channel: "email",
      provider: "email",
      identifier: "Buyer@Example.com",
      otpExpiresAt: 4_102_444_800,
    });

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(target.identifierHash).toBe(first);
    expect(target.identifierMasked).toBe("B***@Example.com");
    expect(target.purpose).toBe("customer_login");
    expect(target.otpExpiresAt).toBe(4_102_444_800);
  });

  it("creates provider client references that fit Bangladesh SMS idempotency limits", async () => {
    const target = await createAuthOtpDeliveryTarget({
      deliveryKey: "otp_delivery_sms_1",
      method: "phone",
      channel: "sms",
      provider: "gennet",
      identifier: "+8801712345678",
    });
    const clientReference = createAuthOtpProviderClientReference(target);

    expect(clientReference).toMatch(/^[a-zA-Z0-9]+$/);
    expect(clientReference.length).toBeLessThanOrEqual(20);
    expect(maskOtpIdentifier("+8801712345678")).toBe("***5678");
  });

  it("creates opaque OTP delivery keys without punctuation that providers reject", () => {
    const deliveryKey = createAuthOtpDeliveryKey();

    expect(deliveryKey).toMatch(/^otp_[a-f0-9]+$/);
    expect(deliveryKey).not.toContain("-");
  });
});
