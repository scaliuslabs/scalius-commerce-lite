import { beforeEach, describe, expect, it, vi } from "vitest";

const challengeMocks = vi.hoisted(() => ({
  persistCustomerAuthOtpChallenge: vi.fn(),
  claimCustomerAuthOtpChallenge: vi.fn(),
  deleteCustomerAuthOtpChallenge: vi.fn(),
  cleanupExpiredCustomerAuthOtpChallenges: vi.fn(),
}));

vi.mock("./customer-auth-otp-challenges", () => ({
  persistCustomerAuthOtpChallenge: challengeMocks.persistCustomerAuthOtpChallenge,
  claimCustomerAuthOtpChallenge: challengeMocks.claimCustomerAuthOtpChallenge,
  deleteCustomerAuthOtpChallenge: challengeMocks.deleteCustomerAuthOtpChallenge,
  cleanupExpiredCustomerAuthOtpChallenges: challengeMocks.cleanupExpiredCustomerAuthOtpChallenges,
}));

import { sendOtp, verifyOtp } from "./customer-auth.service";

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
  beforeEach(() => {
    vi.clearAllMocks();
    challengeMocks.persistCustomerAuthOtpChallenge.mockImplementation(async (_db, input) => ({
      otpKey: input.otpKey,
      deliveryKey: input.deliveryKey,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    }));
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValue({
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      intent: "sign_up",
      identifier: "+8801712345678",
      contactEmail: "original@example.com",
      phone: "+8801712345678",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });
  });

  it("does not reveal duplicate phone during email OTP account creation before OTP proof", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
    ]);
    const kv = createKv();

    const result = await sendOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "new@example.com",
      phone: "+8801712345678",
      name: "New Customer",
      ip: "unknown",
    });

    expect(result).toMatchObject({
      success: true,
      message: "Verification code sent. Please check your selected contact.",
    });
    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: "cust_otp:email:new@example.com",
        method: "email",
        channel: "email",
        identifier: "new@example.com",
        phone: "+8801712345678",
        intent: "sign_up",
      }),
    );
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
    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: "cust_otp:email:buyer@example.com",
        method: "email",
        channel: "email",
        identifier: "buyer@example.com",
        intent: "sign_in",
      }),
    );
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("stores phone OTP challenges under channel-scoped keys", async () => {
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
    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: "cust_otp:sms:+8801712345678",
        method: "phone",
        channel: "sms",
        identifier: "+8801712345678",
      }),
    );
    expect(kv.get).not.toHaveBeenCalledWith("cust_otp:sms:+8801712345678", "text");
    expect(kv.put).not.toHaveBeenCalledWith(
      "cust_otp:sms:+8801712345678",
      expect.any(String),
      { expirationTtl: 300 },
    );
  });

  it("pins the account creation contact fields accepted when the OTP is issued", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
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

    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: "cust_otp:sms:+8801712345678",
        method: "phone",
        identifier: "+8801712345678",
        contactEmail: "buyer@example.com",
        phone: "+8801712345678",
        intent: "sign_up",
        channel: "sms",
      }),
    );
  });

  it("rejects SMS OTP when no SMS provider is configured before mutating OTP challenge state", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
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

    expect(challengeMocks.persistCustomerAuthOtpChallenge).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("uses pinned OTP contact fields instead of tampered verify payload fields", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: null },
      { get: null },
      { get: null },
    ]);
    const kv = createKv();

    const result = await verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Buyer",
      email: "tampered@example.com",
      encryptionKey: "test-key",
    });

    expect(result.success).toBe(true);
    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      email: "original@example.com",
      phone: "+8801712345678",
    }));
  });

  it("rejects verify payloads that try to reinterpret a phone OTP as email verification", async () => {
    const db = createDb([]);
    const kv = createKv();

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
    expect(challengeMocks.claimCustomerAuthOtpChallenge).not.toHaveBeenCalled();
  });

  it("bubbles OTP challenge destination mismatches before account mutation", async () => {
    const db = createDb([]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockRejectedValueOnce(
      new Error("Verification code does not match the requested contact. Please request a new code."),
    );

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

  it("does not read legacy KV OTP records during verification", async () => {
    const db = createDb([]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockRejectedValueOnce(
      new Error("No verification code found. Please request a new one."),
    );

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      phone: "+8801712345678",
      encryptionKey: "test-key",
    })).rejects.toThrow("No verification code found. Please request a new one.");

    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.delete).not.toHaveBeenCalled();
    expect(db.insertValues).not.toHaveBeenCalled();
  });

  it("rechecks required email policy during phone OTP account creation verification", async () => {
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
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      intent: "sign_up",
      identifier: "+8801712345678",
      phone: "+8801712345678",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
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
    expect(kv.put).not.toHaveBeenCalled();
  });
});
