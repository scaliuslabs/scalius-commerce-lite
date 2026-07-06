import { beforeEach, describe, expect, it, vi } from "vitest";

const challengeMocks = vi.hoisted(() => ({
  buildCustomerAuthOtpStorageKey: vi.fn(),
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
  buildCustomerAuthOtpStorageKey: challengeMocks.buildCustomerAuthOtpStorageKey,
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
  getCookieConfig,
  getCustomerBySession,
  normalizeCustomerAuthCookieDomain,
  sendOtp,
  updateCustomerProfile,
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

describe("customer auth cookie domain", () => {
  it("keeps customer auth cookies host-only by default for custom domains", () => {
    expect(getCookieConfig("https://shop.example.co.uk")).toEqual({
      sameSite: "None",
      domainAttr: "",
    });
  });

  it("uses an explicit cookie domain only when one is configured", () => {
    expect(getCookieConfig("https://storefront.scalius.com", "scalius.com")).toEqual({
      sameSite: "None",
      domainAttr: "; Domain=.scalius.com",
    });
    expect(getCookieConfig("https://storefront.scalius.com", ".SCALIUS.com.")).toEqual({
      sameSite: "None",
      domainAttr: "; Domain=.scalius.com",
    });
  });

  it("ignores invalid cookie domain values", () => {
    expect(normalizeCustomerAuthCookieDomain("localhost")).toBe("");
    expect(normalizeCustomerAuthCookieDomain("127.0.0.1")).toBe("");
    expect(normalizeCustomerAuthCookieDomain("shop")).toBe("");
    expect(normalizeCustomerAuthCookieDomain("https://example.com")).toBe("");
  });
});

function createDb(selectResults: Array<{ limit?: unknown[]; get?: unknown; all?: unknown[] }>) {
  const queue = [...selectResults];
  const insertValues = vi.fn(async (_values: unknown) => undefined);
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];
  const updateCalls: Array<{ table: unknown; values: unknown }> = [];
  type FakeStatement =
    | { type: "insert"; table: unknown; values: unknown }
    | { type: "update"; table: unknown; values: unknown };
  const executeStatement = async (statement: FakeStatement) => {
    if (statement.type === "insert") {
      insertCalls.push({ table: statement.table, values: statement.values });
      await insertValues(statement.values);
      return [];
    }
    updateCalls.push({ table: statement.table, values: statement.values });
    return [];
  };
  const batch = vi.fn(async (statements: FakeStatement[]) =>
    Promise.all(statements.map(executeStatement))
  );
  return {
    select: vi.fn(() => ({
        from: vi.fn(() => ({
        limit: vi.fn(async () => {
          const result = queue.shift();
          return result?.limit ?? [];
        }),
        where: vi.fn(() => ({
          get: vi.fn(async () => {
            const result = queue[0];
            if (!result || !("get" in result)) return null;
            queue.shift();
            return result.get ?? null;
          }),
          all: vi.fn(async () => {
            const result = queue[0];
            if (!result || !("all" in result)) return [];
            queue.shift();
            return result.all ?? [];
          }),
          limit: vi.fn(() => ({
            all: vi.fn(async () => {
              const result = queue[0];
              if (!result || !("all" in result)) return [];
              queue.shift();
              return result.all ?? [];
            }),
          })),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => ({ type: "insert", table, values })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => ({ type: "update", table, values })),
      })),
    })),
    batch,
    insertValues,
    insertCalls,
    updateCalls,
  };
}

const readySmsSettings = [
  { key: "active_provider", value: "bdbulksms" },
  { key: "bdbulksms_token", value: "scalius-local-token-789" },
];
const readyEmailSettings = [
  { key: "email_provider", value: "cloudflare" },
  { key: "email_sender", value: "orders@example.com" },
];
const readyEmailEnv = {
  EMAIL: { send: vi.fn() },
};
const otpInputSecrets = {
  encryptionKey: "test-otp-signing-key",
  credentialEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
};

function createCustomerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cust_1",
    name: "Buyer",
    email: "buyer@example.com",
    phone: "+8801712345678",
    address: null,
    city: null,
    zone: null,
    area: null,
    cityName: null,
    zoneName: null,
    areaName: null,
    profileCompletionRequiredAt: null,
    profileCompletedAt: null,
    totalOrders: 0,
    totalSpent: 0,
    lastOrderAt: null,
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
    deletedAt: null,
    ...overrides,
  };
}

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
    challengeMocks.buildCustomerAuthOtpStorageKey.mockImplementation(async (channel: string) => (
      `cust_otp:${channel}:${"a".repeat(64)}`
    ));
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
      ...otpInputSecrets,
    });

    expect(result).toMatchObject({
      success: true,
      message: "Verification code sent. Please check your selected contact.",
    });
    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: expect.stringMatching(/^cust_otp:email:[a-f0-9]{64}$/),
        method: "email",
        channel: "email",
        identifier: "new@example.com",
        deliveryTarget: "new@example.com",
        deliveryName: "New Customer",
        phone: "+8801712345678",
        intent: "sign_up",
      }),
    );
    const persistedCode = challengeMocks.persistCustomerAuthOtpChallenge.mock.calls[0]?.[1]?.code;
    expect(typeof persistedCode).toBe("string");
    expect(result.queuePayload).toMatchObject({
      type: "auth.send_otp",
      challengeKey: expect.stringMatching(/^cust_otp:email:[a-f0-9]{64}$/),
      deliveryKey: expect.stringMatching(/^otp_[a-f0-9]+$/),
    });
    expect(result.queuePayload).not.toHaveProperty("code");
    expect(result.queuePayload).not.toHaveProperty("identifier");
    expect(result.queuePayload).not.toHaveProperty("name");
    expect(JSON.stringify(result.queuePayload)).not.toContain(persistedCode);
    expect(JSON.stringify(result.queuePayload)).not.toContain("new@example.com");
    expect(JSON.stringify(result.queuePayload)).not.toContain("+8801712345678");
    expect(JSON.stringify(result.queuePayload)).not.toContain("New Customer");
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
      ...otpInputSecrets,
    });

    expect(result.success).toBe(true);
    expect(result.queuePayload).toMatchObject({
      method: "email",
      channel: "email",
    });
    expect(result.queuePayload).not.toHaveProperty("identifier");
    expect(result.queuePayload).not.toHaveProperty("name");
    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: expect.stringMatching(/^cust_otp:email:[a-f0-9]{64}$/),
        method: "email",
        channel: "email",
        identifier: "buyer@example.com",
        deliveryTarget: "buyer@example.com",
        deliveryName: "Buyer",
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
      ...otpInputSecrets,
    })).rejects.toThrow("Too many requests from this IP. Please try again later.");

    expect(challengeMocks.persistCustomerAuthOtpChallenge).not.toHaveBeenCalled();
    expect(rateLimitMocks.enforceCustomerAuthOtpIpRateLimit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ip: "203.0.113.20",
        hashKey: otpInputSecrets.encryptionKey,
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
      ...otpInputSecrets,
    });

    expect(result.success).toBe(true);
    expect(result.queuePayload).toMatchObject({
      method: "phone",
      channel: "sms",
    });
    expect(result.queuePayload).not.toHaveProperty("identifier");
    expect(result.queuePayload).not.toHaveProperty("name");
    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: expect.stringMatching(/^cust_otp:sms:[a-f0-9]{64}$/),
        method: "phone",
        channel: "sms",
        identifier: "+8801712345678",
        deliveryTarget: "+8801712345678",
        deliveryName: "Buyer",
      }),
    );
    const persistInput = challengeMocks.persistCustomerAuthOtpChallenge.mock.calls.at(-1)?.[1] as { otpKey: string };
    expect(persistInput.otpKey).not.toContain("+8801712345678");
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects disallowed primary phone OTP sends before rate limits or challenge mutation", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: { value: JSON.stringify({ countries: ["BD"], mode: "include" }) } },
      { all: readySmsSettings },
    ]);
    const kv = createKv();

    await expect(sendOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "phone",
      channel: "sms",
      identifier: "+14155552671",
      name: "Buyer",
      ip: "unknown",
      ...otpInputSecrets,
    })).rejects.toThrow("Phone numbers from US are not accepted");

    expect(rateLimitMocks.enforceCustomerAuthOtpIpRateLimit).not.toHaveBeenCalled();
    expect(challengeMocks.persistCustomerAuthOtpChallenge).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects disallowed secondary signup phones before email OTP challenge mutation", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { get: { value: JSON.stringify({ countries: ["BD"], mode: "include" }) } },
      { all: readyEmailSettings },
    ]);
    const kv = createKv();

    await expect(sendOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      phone: "+14155552671",
      name: "Buyer",
      ip: "unknown",
      emailEnv: readyEmailEnv,
      ...otpInputSecrets,
    })).rejects.toThrow("Phone numbers from US are not accepted");

    expect(rateLimitMocks.enforceCustomerAuthOtpIpRateLimit).not.toHaveBeenCalled();
    expect(challengeMocks.persistCustomerAuthOtpChallenge).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
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
      ...otpInputSecrets,
    });

    expect(challengeMocks.persistCustomerAuthOtpChallenge).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        otpKey: expect.stringMatching(/^cust_otp:sms:[a-f0-9]{64}$/),
        method: "phone",
        identifier: "+8801712345678",
        contactEmail: "buyer@example.com",
        phone: undefined,
        intent: "sign_up",
        channel: "sms",
        contactEncryptionKey: otpInputSecrets.credentialEncryptionKey,
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
      ...otpInputSecrets,
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
      ...otpInputSecrets,
    })).rejects.toThrow("Email verification is currently unavailable. Contact store support.");

    expect(challengeMocks.persistCustomerAuthOtpChallenge).not.toHaveBeenCalled();
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects ambiguous email sign-in after OTP proof without creating a session", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: [
        createCustomerRow({ id: "cust_1", phone: "+8801711111111" }),
        createCustomerRow({ id: "cust_2", phone: "+8801722222222" }),
      ] },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:email:buyer@example.com",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "buyer@example.com",
      contactEmail: "buyer@example.com",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("Multiple accounts use this email. Please use phone verification or contact store support.");

    expect(db.insertValues).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects sign-in when no active email customer matches", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: [] },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:email:deleted@example.com",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "deleted@example.com",
      contactEmail: "deleted@example.com",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "deleted@example.com",
      code: "123456",
      name: "Deleted Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("No account was found for this email. Create an account instead.");

    expect(db.insertValues).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns restore-support guidance for soft-deleted email sign-in after OTP proof", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: [] },
      { get: { id: "cust_deleted" } },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:email:deleted@example.com",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "deleted@example.com",
      contactEmail: "deleted@example.com",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "deleted@example.com",
      code: "123456",
      name: "Deleted Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("This email belongs to a deleted customer account. Contact store support to restore access.");

    expect(db.insertValues).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("signs in the single active email customer while ignoring deleted duplicates", async () => {
    const activeCustomer = createCustomerRow({
      id: "cust_active",
      email: "buyer@example.com",
      phone: "+8801712345678",
      address: "House 1",
      city: "city_dhaka",
      zone: "zone_mirpur",
    });
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: [activeCustomer] },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:email:buyer@example.com",
      method: "email",
      channel: "email",
      intent: "sign_in",
      identifier: "buyer@example.com",
      contactEmail: "buyer@example.com",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    const result = await verifyOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    });

    expect(result.success).toBe(true);
    expect(result.session?.customerId).toBe("cust_active");
    expect(result.customer?.customerId).toBe("cust_active");
    const sessionInsert = db.insertCalls.find(({ values }) => {
      const row = values as Record<string, unknown>;
      return typeof row.tokenHash === "string" && row.customerId === "cust_active";
    });
    expect(sessionInsert?.values).toMatchObject({
      customerId: "cust_active",
      revokedAt: null,
    });
    expect(db.updateCalls[0]?.values).toMatchObject({
      accountClaimedAt: expect.anything(),
      emailVerifiedAt: expect.anything(),
      lastAuthenticatedAt: expect.anything(),
    });
    expect(db.updateCalls[0]?.values as Record<string, unknown>).not.toHaveProperty("phoneVerifiedAt");
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects phone sign-in when no active phone customer matches", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: null },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      intent: "sign_in",
      identifier: "+8801712345678",
      phone: "+8801712345678",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Deleted Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("No account was found for this phone number. Create an account instead.");

    expect(db.insertValues).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns restore-support guidance for soft-deleted phone sign-in after OTP proof", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: null },
      { get: null },
      { get: { id: "cust_deleted" } },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:sms:+8801712345678",
      method: "phone",
      channel: "sms",
      intent: "sign_in",
      identifier: "+8801712345678",
      phone: "+8801712345678",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_in",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Deleted Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("This phone number belongs to a deleted customer account. Contact store support to restore access.");

    expect(db.insertValues).not.toHaveBeenCalled();
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
      accountClaimedAt: expect.anything(),
      phoneVerifiedAt: expect.anything(),
      emailVerifiedAt: null,
      lastAuthenticatedAt: expect.anything(),
      profileCompletionRequiredAt: expect.any(Date),
      profileCompletedAt: null,
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
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("marks only the OTP-proven email as verified when email sign-up collects phone", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { all: [] },
      { all: [] },
      { get: null },
      { get: null },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:email:buyer@example.com",
      method: "email",
      channel: "email",
      intent: "sign_up",
      identifier: "buyer@example.com",
      contactEmail: "buyer@example.com",
      phone: "+8801712345678",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).resolves.toMatchObject({
      success: true,
      isNewUser: true,
    });

    expect(db.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      email: "buyer@example.com",
      phone: "+8801712345678",
      accountClaimedAt: expect.anything(),
      phoneVerifiedAt: null,
      emailVerifiedAt: expect.anything(),
      lastAuthenticatedAt: expect.anything(),
    }));
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("does not persist a sign-up customer outside the account/session batch when session persistence fails", async () => {
    const db = createDb([
      { limit: [{ ...baseSiteSettings, authVerificationMethod: "sms_otp" }] },
      { get: null },
      { get: null },
      { get: null },
      { get: null },
    ]);
    db.batch.mockRejectedValueOnce(new Error("session insert failed"));
    const kv = createKv();

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "phone",
      channel: "sms",
      identifier: "+8801712345678",
      code: "123456",
      name: "Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("Customer session could not be created. Please try again.");

    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.batch.mock.calls[0]?.[0]).toHaveLength(2);
    expect(db.insertValues).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("rejects a now-disallowed pinned OTP phone before customer or session creation", async () => {
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
      { get: { value: JSON.stringify({ countries: ["BD"], mode: "include" }) } },
    ]);
    const kv = createKv();
    challengeMocks.claimCustomerAuthOtpChallenge.mockResolvedValueOnce({
      otpKey: "cust_otp:email:buyer@example.com",
      method: "email",
      channel: "email",
      intent: "sign_up",
      identifier: "buyer@example.com",
      contactEmail: "buyer@example.com",
      phone: "+14155552671",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(verifyOtp(db as never, kv as never, {
      intent: "sign_up",
      method: "email",
      channel: "email",
      identifier: "buyer@example.com",
      code: "123456",
      name: "Buyer",
      encryptionKey: "test-key",
      sessionHashKey: "session-test-key",
    })).rejects.toThrow("Phone numbers from US are not accepted");

    expect(challengeMocks.claimCustomerAuthOtpChallenge).toHaveBeenCalledOnce();
    expect(db.insertValues).not.toHaveBeenCalled();
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
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
    ]);
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
    const db = createDb([
      { limit: [baseSiteSettings] },
      { get: null },
    ]);
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
      customerAddress: "House 1",
      customerCity: "city_dhaka",
      customerZone: "zone_mirpur",
      customerArea: "area_1",
      customerCityName: "Dhaka",
      customerZoneName: "Mirpur",
      customerAreaName: "Section 10",
      customerProfileCompletionRequiredAt: 3_100,
      customerProfileCompletedAt: 3_200,
    });

    const session = await getCustomerBySession(db as never, "raw-session-token", "session-key");

    expect(session).toEqual({
      token: "raw-session-token",
      email: "buyer@example.com",
      name: "Buyer",
      phone: "+8801712345678",
      customerId: "cust_1",
      address: "House 1",
      city: "city_dhaka",
      zone: "zone_mirpur",
      area: "area_1",
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: "Section 10",
      profileComplete: true,
      needsProfileCompletion: false,
      createdAt: 3_000_000,
      expiresAt: 4_200_000,
    });
  });

  it("updates customer profile from active delivery location IDs and returns canonical profile", async () => {
    const existingCustomer = {
      id: "cust_1",
      name: "Old Name",
      email: "buyer@example.com",
      phone: "+8801712345678",
      address: null,
      city: null,
      zone: null,
      area: null,
      cityName: null,
      zoneName: null,
      areaName: null,
      profileCompletionRequiredAt: 3_000,
      profileCompletedAt: null,
      totalOrders: 0,
      totalSpent: 0,
      lastOrderAt: null,
      createdAt: 2_000,
      updatedAt: 2_000,
      deletedAt: null,
    };
    const updatedCustomer = {
      ...existingCustomer,
      name: "Buyer",
      address: "House 1",
      city: "city_dhaka",
      zone: "zone_mirpur",
      area: "area_1",
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: "Section 10",
      profileCompletedAt: 3_200,
    };
    const customerReads = [existingCustomer, updatedCustomer];
    const updateSet = vi.fn((_payload: Record<string, unknown>) => ({ where: vi.fn(async () => undefined) }));
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => {
          if (db.select.mock.calls.length === 2) {
            return {
              where: vi.fn(() => ({
                get: vi.fn(async () => null),
              })),
            };
          }
          if (db.select.mock.calls.length === 3) {
            return {
              where: vi.fn(async () => [
                { id: "city_dhaka", name: "Dhaka", type: "city", parentId: null, isActive: true, deletedAt: null },
                { id: "zone_mirpur", name: "Mirpur", type: "zone", parentId: "city_dhaka", isActive: true, deletedAt: null },
                { id: "area_1", name: "Section 10", type: "area", parentId: "zone_mirpur", isActive: true, deletedAt: null },
              ]),
            };
          }
          return {
            where: vi.fn(() => ({
              get: vi.fn(async () => customerReads.shift() ?? null),
            })),
          };
        }),
      })),
      update: vi.fn(() => ({ set: updateSet })),
    };

    const result = await updateCustomerProfile(
      db as never,
      {
        token: "raw-session-token",
        email: "buyer@example.com",
        name: "Old Name",
        phone: "+8801712345678",
        customerId: "cust_1",
        profileComplete: false,
        needsProfileCompletion: true,
        createdAt: 2_000_000,
        expiresAt: 4_200_000,
      },
      {
        name: "Buyer",
        address: "House 1",
        city: "city_dhaka",
        zone: "zone_mirpur",
        area: "area_1",
        cityName: "Forged City",
        zoneName: "Forged Zone",
      },
    );

    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({
      name: "Buyer",
      address: "House 1",
      city: "city_dhaka",
      zone: "zone_mirpur",
      area: "area_1",
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: "Section 10",
    }));
    const updatePayload = updateSet.mock.calls[0]?.[0] ?? {};
    expect(updatePayload).not.toMatchObject({
      cityName: "Forged City",
      zoneName: "Forged Zone",
    });
    expect(result.customer).toMatchObject({
      customerId: "cust_1",
      address: "House 1",
      city: "city_dhaka",
      zone: "zone_mirpur",
      area: "area_1",
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: "Section 10",
      profileComplete: true,
      needsProfileCompletion: false,
    });
  });

  it("rejects profile completion when the existing customer phone is no longer allowed", async () => {
    const getResults = [
      {
        id: "cust_us",
        name: "Buyer",
        email: "buyer@example.com",
        phone: "+14155552671",
        address: null,
        city: null,
        zone: null,
        area: null,
        cityName: null,
        zoneName: null,
        areaName: null,
        profileCompletionRequiredAt: 3_000,
        profileCompletedAt: null,
        totalOrders: 0,
        totalSpent: 0,
        lastOrderAt: null,
        createdAt: 2_000,
        updatedAt: 2_000,
        deletedAt: null,
      },
      { value: JSON.stringify({ countries: ["BD"], mode: "include" }) },
    ];
    const update = vi.fn();
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            get: vi.fn(async () => getResults.shift() ?? null),
          })),
        })),
      })),
      update,
    };

    await expect(updateCustomerProfile(
      db as never,
      {
        token: "raw-session-token",
        email: "buyer@example.com",
        name: "Buyer",
        phone: "+14155552671",
        customerId: "cust_us",
        profileComplete: false,
        needsProfileCompletion: true,
        createdAt: 2_000_000,
        expiresAt: 4_200_000,
      },
      {
        name: "Buyer",
        address: "House 1",
      },
    )).rejects.toThrow("Phone numbers from US are not accepted");

    expect(update).not.toHaveBeenCalled();
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
