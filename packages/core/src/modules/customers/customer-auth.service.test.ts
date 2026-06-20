import { describe, expect, it, vi } from "vitest";

import { sendOtp, verifyOtp, type StoredOtp } from "./customer-auth.service";

const baseSiteSettings = {
  id: "site_settings_1",
  authVerificationMethod: "email",
  guestCheckoutEnabled: true,
  checkoutMode: "all",
  partialPaymentEnabled: false,
  partialPaymentAmount: 0,
  whatsappAccessToken: null,
  whatsappPhoneNumberId: null,
  whatsappTemplateName: "auth_otp",
};

function createDb(selectResults: Array<{ limit?: unknown[]; get?: unknown; all?: unknown[] }>) {
  const queue = [...selectResults];
  const insertValues = vi.fn(async () => undefined);
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => {
          const result = queue.shift();
          return result?.limit ?? [];
        }),
        where: vi.fn(() => ({
          get: vi.fn(async () => {
            const result = queue.shift();
            return result?.get ?? null;
          }),
          all: vi.fn(async () => {
            const result = queue.shift();
            return result?.all ?? [];
          }),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: insertValues,
    })),
    insertValues,
  };
}

const readySmsSettings = [
  { key: "active_provider", value: "bdbulksms" },
  { key: "bdbulksms_token", value: "test-token" },
];

function createKv(initialValues: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialValues));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    store,
  };
}

describe("customer auth service intent handling", () => {
  it("rejects duplicate phone during email OTP account creation before mutating OTP KV", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { get: null },
      { get: { id: "cust_existing", phone: "+8801712345678" } },
    ]);
    const kv = createKv();

    await expect(sendOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "new@example.com",
      phone: "+8801712345678",
      name: "New Customer",
      ip: "unknown",
    })).rejects.toThrow("An account already exists for this phone number. Sign in instead.");

    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("allows existing customers to sign in with email OTP without duplicate-phone account creation checks", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      {
        get: {
          id: "cust_existing",
          email: "buyer@example.com",
          phone: "+8801712345678",
        },
      },
    ]);
    const kv = createKv();

    const result = await sendOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      phone: "+8801712345678",
      name: "Buyer",
      ip: "unknown",
    });

    expect(result.success).toBe(true);
    expect(result.queuePayload).toMatchObject({
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
    });
    expect(kv.put).toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledWith(
      "cust_otp:email:buyer@example.com",
      expect.any(String),
      { expirationTtl: 300 },
    );
  });

  it("stores phone OTP cooldowns under channel-scoped keys", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      {
        get: {
          value: JSON.stringify({
            otpChannels: ["sms", "whatsapp"],
            requiredContactFields: [],
            optionalContactFields: ["email"],
            defaultOtpChannel: "sms",
          }),
        },
      },
      {
        get: {
          id: "cust_existing",
          email: null,
          phone: "+8801712345678",
        },
      },
      { all: readySmsSettings },
    ]);
    const kv = createKv();

    const result = await sendOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      name: "Buyer",
      ip: "unknown",
    });

    expect(result.success).toBe(true);
    expect(result.queuePayload).toMatchObject({
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
    });
    expect(kv.get).toHaveBeenCalledWith("cust_otp:sms:+8801712345678", "text");
    expect(kv.put).toHaveBeenCalledWith(
      "cust_otp:sms:+8801712345678",
      expect.any(String),
      { expirationTtl: 300 },
    );
  });

  it("pins the account creation contact fields accepted when the OTP is issued", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: null },
      { get: null },
      { all: readySmsSettings },
    ]);
    const kv = createKv();

    await sendOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      email: "Buyer@Example.COM",
      name: "Buyer",
      ip: "unknown",
    });

    const [, storedRaw] = kv.put.mock.calls.find(([key]) => key === "cust_otp:sms:+8801712345678") ?? [];
    const stored = JSON.parse(storedRaw as string) as StoredOtp;
    expect(stored).toMatchObject({
      method: "phone",
      identifier: "+8801712345678",
      contactEmail: "buyer@example.com",
      phone: "+8801712345678",
      intent: "sign_up",
      channel: "sms",
    });
  });

  it("rejects SMS OTP when no SMS provider is configured before mutating OTP KV", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      {
        get: {
          id: "cust_existing",
          email: null,
          phone: "+8801712345678",
        },
      },
      { all: [] },
    ]);
    const kv = createKv();

    await expect(sendOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      name: "Buyer",
      ip: "unknown",
    })).rejects.toThrow("SMS verification is currently unavailable. Contact store support.");

    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("uses pinned OTP contact fields instead of tampered verify payload fields", async () => {
    const otpKey = "cust_otp:sms:+8801712345678";
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: null },
      { get: null },
      { get: null },
    ]);
    const kv = createKv({
      [otpKey]: JSON.stringify({
        code: "123456",
        email: "original@example.com",
        method: "phone",
        identifier: "+8801712345678",
        contactEmail: "original@example.com",
        phone: "+8801712345678",
        expiresAt: Date.now() + 300_000,
        attempts: 0,
        intent: "sign_up",
        channel: "sms",
      } satisfies StoredOtp),
    });

    const result = await verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Buyer",
      email: "tampered@example.com",
    });

    expect(result.success).toBe(true);
    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      email: "original@example.com",
      phone: "+8801712345678",
    }));
  });

  it("rejects verify payloads that try to reinterpret a phone OTP as email verification", async () => {
    const db = createDb([]);
    const kv = createKv({
      "cust_otp:sms:+8801712345678": JSON.stringify({
        code: "123456",
        email: "original@example.com",
        method: "phone",
        identifier: "+8801712345678",
        contactEmail: "original@example.com",
        phone: "+8801712345678",
        expiresAt: Date.now() + 300_000,
        attempts: 0,
        intent: "sign_up",
        channel: "sms",
      } satisfies StoredOtp),
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Buyer",
      phone: "+8801712345678",
    })).rejects.toThrow("Valid email address required");

    expect(kv.delete).not.toHaveBeenCalled();
    expect(db.insertValues).not.toHaveBeenCalled();
  });

  it("rejects OTP records whose stored destination does not match the verify request", async () => {
    const otpKey = "cust_otp:email:buyer@example.com";
    const db = createDb([]);
    const kv = createKv({
      [otpKey]: JSON.stringify({
        code: "123456",
        email: "buyer@example.com",
        method: "phone",
        identifier: "+8801712345678",
        contactEmail: "buyer@example.com",
        phone: "+8801712345678",
        expiresAt: Date.now() + 300_000,
        attempts: 0,
        intent: "sign_up",
        channel: "email",
      } satisfies StoredOtp),
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      phone: "+8801712345678",
    })).rejects.toThrow("Verification code does not match the requested contact. Please request a new code.");

    expect(kv.delete).not.toHaveBeenCalled();
    expect(db.insertValues).not.toHaveBeenCalled();
  });

  it("clears legacy OTP records that do not carry pinned method metadata", async () => {
    const otpKey = "cust_otp:email:buyer@example.com";
    const db = createDb([]);
    const kv = createKv({
      [otpKey]: JSON.stringify({
        code: "123456",
        email: "buyer@example.com",
        contactEmail: "buyer@example.com",
        phone: "+8801712345678",
        expiresAt: Date.now() + 300_000,
        attempts: 0,
        intent: "sign_up",
        channel: "email",
      }),
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      phone: "+8801712345678",
    })).rejects.toThrow("Verification code could not be verified. Please request a new code.");

    expect(kv.delete).toHaveBeenCalledWith(otpKey);
    expect(db.insertValues).not.toHaveBeenCalled();
  });

  it("rechecks required email policy during phone OTP account creation verification", async () => {
    const otpKey = "cust_otp:sms:+8801712345678";
    const db = createDb([
      {
        limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }],
      },
      {
        get: {
          value: JSON.stringify({
            otpChannels: ["sms"],
            requiredContactFields: ["phone", "email"],
            optionalContactFields: [],
            defaultOtpChannel: "sms",
          }),
        },
      },
    ]);
    const kv = createKv({
      [otpKey]: JSON.stringify({
        code: "123456",
        email: "+8801712345678",
        method: "phone",
        identifier: "+8801712345678",
        phone: "+8801712345678",
        expiresAt: Date.now() + 300_000,
        attempts: 0,
        intent: "sign_up",
        channel: "sms",
      } satisfies StoredOtp),
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Buyer",
    })).rejects.toThrow("Email address is required to create an account.");

    expect(db.insertValues).not.toHaveBeenCalled();
    expect(kv.put).toHaveBeenCalledWith(otpKey, expect.any(String), { expirationTtl: expect.any(Number) });
  });
});
