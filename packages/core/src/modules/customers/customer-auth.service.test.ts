import { beforeEach, describe, expect, it, vi } from "vitest";

const challengeMocks = vi.hoisted(() => ({
  persistCustomerAuthOtpChallenge: vi.fn(),
  claimCustomerAuthOtpChallenge: vi.fn(),
  deleteCustomerAuthOtpChallenge: vi.fn(),
  cleanupExpiredCustomerAuthOtpChallenges: vi.fn(),
}));
const rateLimitMocks = vi.hoisted(() => ({
  enforceCustomerAuthOtpIpRateLimit: vi.fn(),
  cleanupExpiredCustomerAuthOtpRateLimits: vi.fn(),
}));

vi.mock("./customer-auth-otp-challenges", () => ({
  persistCustomerAuthOtpChallenge: challengeMocks.persistCustomerAuthOtpChallenge,
  claimCustomerAuthOtpChallenge: challengeMocks.claimCustomerAuthOtpChallenge,
  deleteCustomerAuthOtpChallenge: challengeMocks.deleteCustomerAuthOtpChallenge,
  cleanupExpiredCustomerAuthOtpChallenges: challengeMocks.cleanupExpiredCustomerAuthOtpChallenges,
}));

vi.mock("./customer-auth-rate-limit", () => ({
  enforceCustomerAuthOtpIpRateLimit: rateLimitMocks.enforceCustomerAuthOtpIpRateLimit,
  cleanupExpiredCustomerAuthOtpRateLimits: rateLimitMocks.cleanupExpiredCustomerAuthOtpRateLimits,
}));

import {
  cleanupExpiredCustomerSessions,
  deleteCustomerSession,
  getCustomerBySession,
  sendOtp,
  verifyOtp,
} from "./customer-auth.service";

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
  const insertValues = vi.fn(async (_values: unknown) => undefined);
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];
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
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        insertCalls.push({ table, values });
        return insertValues(values);
      }),
    })),
    insertValues,
    insertCalls,
  };
}

const readySmsSettings = [
  { key: "active_provider", value: "bdbulksms" },
  { key: "bdbulksms_token", value: "test-token" },
];
const readyEmailSettings = [
  { key: "email_provider", value: "cloudflare" },
  { key: "email_sender", value: "orders@example.com" },
];
const readyEmailEnv = {
  EMAIL: { send: vi.fn() },
};

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
    rateLimitMocks.enforceCustomerAuthOtpIpRateLimit.mockResolvedValue(undefined);
  });

  it("does not reveal duplicate phone during email OTP account creation before OTP proof", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: readyEmailSettings },
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
      emailEnv: readyEmailEnv,
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
    expect(rateLimitMocks.enforceCustomerAuthOtpIpRateLimit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ip: "unknown",
      }),
    );
    const rateLimitCallOrder = rateLimitMocks.enforceCustomerAuthOtpIpRateLimit.mock.invocationCallOrder[0];
    const challengeCallOrder = challengeMocks.persistCustomerAuthOtpChallenge.mock.invocationCallOrder[0];
    expect(rateLimitCallOrder).toBeDefined();
    expect(challengeCallOrder).toBeDefined();
    expect(rateLimitCallOrder!).toBeLessThan(challengeCallOrder!);
  });

  it("allows existing customers to sign in with email OTP without duplicate-phone account creation checks", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: readyEmailSettings },
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
      emailEnv: readyEmailEnv,
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

  it("rejects rate-limited OTP sends before mutating challenge state", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: readyEmailSettings },
    ]);
    const kv = createKv();
    rateLimitMocks.enforceCustomerAuthOtpIpRateLimit.mockRejectedValueOnce(
      new Error("Too many requests from this IP. Please try again later."),
    );

    await expect(sendOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      name: "Buyer",
      ip: "203.0.113.20",
      emailEnv: readyEmailEnv,
      encryptionKey: "otp-signing-key",
    })).rejects.toThrow("Too many requests from this IP. Please try again later.");

    expect(challengeMocks.persistCustomerAuthOtpChallenge).not.toHaveBeenCalled();
    expect(rateLimitMocks.enforceCustomerAuthOtpIpRateLimit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ip: "203.0.113.20",
        hashKey: "otp-signing-key",
      }),
    );
    expect(kv.get).not.toHaveBeenCalled();
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
    expect(rateLimitMocks.enforceCustomerAuthOtpIpRateLimit).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects email OTP when no email provider is ready before mutating OTP challenge or rate-limit state", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: [] },
    ]);
    const kv = createKv();

    await expect(sendOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      name: "Buyer",
      ip: "203.0.113.20",
    })).rejects.toThrow("Email verification is currently unavailable. Contact store support.");

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
      sessionHashKey: "session-test-key",
    });

    expect(result.success).toBe(true);
    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      email: "original@example.com",
      phone: "+8801712345678",
    }));
    const sessionInsert = db.insertCalls.find(({ values }) => {
      const row = values as Record<string, unknown>;
      return typeof row.tokenHash === "string" && row.customerId === result.session?.customerId;
    });
    expect(sessionInsert?.values).toMatchObject({
      customerId: result.session?.customerId,
      revokedAt: null,
    });
    expect((sessionInsert?.values as { tokenHash?: string }).tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(sessionInsert?.values)).not.toContain(result.session?.token);
    expect(kv.put).not.toHaveBeenCalled();
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

describe("customer auth D1 sessions", () => {
  function createSessionReadDb(row: unknown) {
    const get = vi.fn(async () => row);
    const where = vi.fn(() => ({ get }));
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    const select = vi.fn(() => ({ from }));
    return { db: { select }, get, where, innerJoin, from, select };
  }

  it("reads customer sessions from a live D1 customer row", async () => {
    const { db } = createSessionReadDb({
      tokenHash: "hash",
      customerId: "cust_1",
      expiresAt: 4_200,
      createdAt: 3_000,
      customerName: "Buyer",
      customerEmail: "buyer@example.com",
      customerPhone: "+8801712345678",
    });

    const session = await getCustomerBySession(db as never, "raw-session-token", "session-key");

    expect(session).toEqual({
      token: "raw-session-token",
      email: "buyer@example.com",
      name: "Buyer",
      phone: "+8801712345678",
      customerId: "cust_1",
      createdAt: 3_000_000,
      expiresAt: 4_200_000,
    });
  });

  it("returns null when no active non-deleted D1 session row is found", async () => {
    const { db } = createSessionReadDb(null);

    await expect(getCustomerBySession(db as never, "missing-session", "session-key")).resolves.toBeNull();
  });

  it("revokes customer sessions instead of deleting raw-token KV keys", async () => {
    const where = vi.fn(async () => undefined);
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update };

    await deleteCustomerSession(db as never, "raw-session-token", "session-key");

    expect(update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      revokedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    }));
    expect(JSON.stringify(set.mock.calls)).not.toContain("raw-session-token");
  });

  it("cleans expired and old revoked customer sessions in bounded batches", async () => {
    const limit = vi.fn(async () => [
      { tokenHash: "hash_1" },
      { tokenHash: "hash_2" },
      { tokenHash: "hash_3" },
    ]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const deleteWhere = vi.fn(async () => undefined);
    const deleteFrom = vi.fn(() => ({ where: deleteWhere }));
    const db = { select, delete: deleteFrom };

    const result = await cleanupExpiredCustomerSessions(db as never, 10_000, {
      limit: 2,
      revokedRetentionSeconds: 60,
    });

    expect(result).toEqual({
      scanned: 2,
      deleted: 2,
      limit: 2,
      hasMore: true,
    });
    expect(deleteFrom).toHaveBeenCalled();
    expect(deleteWhere).toHaveBeenCalled();
  });
});
