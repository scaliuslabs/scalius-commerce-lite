import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getActivePaymentMethods,
  getPolarSettings,
  getPolarCheckoutReadiness,
  getSSLCommerzSettings,
  getSSLCommerzCheckoutReadiness,
  getStripeSettings,
  getStripeCheckoutReadiness,
  invalidatePaymentMethodsCache,
  invalidatePolarCache,
  invalidateSSLCommerzCache,
  invalidateStripeCache,
  upsertEncryptedSetting,
} from "./gateway-settings";
import { decryptCredentials, encryptCredentials } from "../../utils/credential-encryption";

function createRejectingDeleteKv(): KVNamespace {
  return {
    delete: vi.fn().mockRejectedValue(new Error("kv unavailable")),
  } as unknown as KVNamespace;
}

function createDbReturningNoSettings() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => [],
        }),
      }),
    }),
  };
}

function createDbReturningCategoryReads(
  rowsByRead: Array<Array<{ key: string; value: string }>>,
) {
  let readIndex = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          all: async () => rowsByRead[readIndex++] ?? [],
        }),
      }),
    }),
  };
}

function createDbCapturingInsert() {
  const captured: { values?: Record<string, unknown> } = {};
  const db = {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => {
        captured.values = values;
        return {
          onConflictDoUpdate: vi.fn(async () => undefined),
        };
      }),
    })),
  };

  return { db, captured };
}

describe("payment gateway settings cache cleanup", () => {
  afterEach(async () => {
    await Promise.all([
      invalidateStripeCache(),
      invalidateSSLCommerzCache(),
      invalidatePolarCache(),
      invalidatePaymentMethodsCache(),
    ]);
    vi.restoreAllMocks();
  });

  it.each([
    ["stripe", invalidateStripeCache, "gw:stripe"],
    ["sslcommerz", invalidateSSLCommerzCache, "gw:sslcommerz"],
    ["polar", invalidatePolarCache, "gw:polar"],
    ["payment methods", invalidatePaymentMethodsCache, "gw:payment_methods"],
  ])("does not throw when %s legacy KV cleanup fails", async (_label, invalidate, key) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = createRejectingDeleteKv();

    await expect(invalidate(kv)).resolves.toBeUndefined();

    expect(kv.delete).toHaveBeenCalledWith(key);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`Legacy KV credential cache delete failed for ${key}`),
      "kv unavailable",
    );
  });

  it("does not throw when stale Stripe KV lookup fails during migration cleanup", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = {
      get: vi.fn().mockRejectedValue(new Error("kv lookup unavailable")),
      delete: vi.fn(),
    } as unknown as KVNamespace;

    await expect(
      getStripeSettings(createDbReturningNoSettings() as never, kv),
    ).resolves.toBeNull();

    expect(kv.get).toHaveBeenCalledWith("gw:stripe");
    expect(kv.delete).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Legacy KV credential cache lookup failed for gw:stripe"),
      "kv lookup unavailable",
    );
  });

  it("bypasses stale in-memory gateway credentials for fresh checkout config reads", async () => {
    const oldDb = createDbReturningCategoryReads([
      [
        { key: "secret_key", value: "sk_old" },
        { key: "publishable_key", value: "pk_old" },
        { key: "webhook_secret", value: "whsec_old" },
        { key: "enabled", value: "true" },
      ],
    ]);
    const freshDb = createDbReturningCategoryReads([
      [
        { key: "secret_key", value: "sk_new" },
        { key: "publishable_key", value: "pk_new" },
        { key: "webhook_secret", value: "whsec_new" },
        { key: "enabled", value: "false" },
      ],
    ]);

    await expect(getStripeSettings(oldDb as never)).resolves.toMatchObject({
      secretKey: "sk_old",
      publishableKey: "pk_old",
      enabled: true,
    });

    await expect(getStripeSettings(freshDb as never)).resolves.toMatchObject({
      secretKey: "sk_old",
      publishableKey: "pk_old",
      enabled: true,
    });
    await expect(
      getStripeSettings(freshDb as never, undefined, undefined, {
        bypassMemoryCache: true,
      }),
    ).resolves.toMatchObject({
      secretKey: "sk_new",
      publishableKey: "pk_new",
      enabled: false,
    });
  });

  it("bypasses stale in-memory payment-method allowlists for fresh checkout config reads", async () => {
    const oldDb = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["cod"]) },
        { key: "default_method", value: "cod" },
      ],
    ]);
    const freshDb = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["polar"]) },
        { key: "default_method", value: "polar" },
      ],
      [
        { key: "access_token", value: "polar_token" },
        { key: "product_id", value: "polar_product" },
        { key: "webhook_secret", value: "polar_webhook" },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(getActivePaymentMethods(oldDb as never)).resolves.toEqual({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });

    await expect(getActivePaymentMethods(freshDb as never)).resolves.toEqual({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });
    await expect(
      getActivePaymentMethods(freshDb as never, undefined, undefined, {
        bypassMemoryCache: true,
      }),
    ).resolves.toEqual({
      enabledMethods: ["polar"],
      defaultMethod: "polar",
    });
  });

  it.each([
    ["explicit empty allowlist", []],
    ["invalid explicit allowlist shape", { method: "cod" }],
    ["unconfigured explicit online method", ["stripe"]],
  ])("fails closed for %s instead of falling back to COD", async (_label, enabledMethods) => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(enabledMethods) },
        { key: "default_method", value: "cod" },
      ],
      [],
      [],
      [],
    ]);

    await expect(
      getActivePaymentMethods(db as never, undefined, undefined, {
        bypassMemoryCache: true,
      }),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it("does not make Stripe active without a publishable key", async () => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["stripe"]) },
        { key: "default_method", value: "stripe" },
      ],
      [
        { key: "secret_key", value: "sk_live_secret" },
        { key: "webhook_secret", value: "whsec_live" },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(
      getActivePaymentMethods(db as never, undefined, undefined, {
        bypassMemoryCache: true,
      }),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it("does not make Polar active without a webhook secret", async () => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["polar"]) },
        { key: "default_method", value: "polar" },
      ],
      [
        { key: "access_token", value: "polar_token" },
        { key: "product_id", value: "polar_product" },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(
      getActivePaymentMethods(db as never, undefined, undefined, {
        bypassMemoryCache: true,
      }),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it("does not make Stripe active when encrypted credentials cannot be decrypted", async () => {
    const key = Buffer.alloc(32, 8).toString("base64");
    const wrongKey = Buffer.alloc(32, 9).toString("base64");
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["stripe"]) },
        { key: "default_method", value: "stripe" },
      ],
      [
        { key: "secret_key", value: `enc:${await encryptCredentials("sk_live_secret", key)}` },
        { key: "publishable_key", value: "pk_live_public" },
        { key: "webhook_secret", value: `enc:${await encryptCredentials("whsec_live", key)}` },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(
      getActivePaymentMethods(db as never, undefined, wrongKey, {
        bypassMemoryCache: true,
      }),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it("reports gateway credential errors instead of treating ciphertext as configured", async () => {
    const key = Buffer.alloc(32, 10).toString("base64");
    const wrongKey = Buffer.alloc(32, 11).toString("base64");
    const stripeDb = createDbReturningCategoryReads([
      [
        { key: "secret_key", value: `enc:${await encryptCredentials("sk_live_secret", key)}` },
        { key: "publishable_key", value: "pk_live_public" },
        { key: "webhook_secret", value: `enc:${await encryptCredentials("whsec_live", key)}` },
        { key: "enabled", value: "true" },
      ],
    ]);
    const sslDb = createDbReturningCategoryReads([
      [
        { key: "store_id", value: "store_test" },
        { key: "store_password", value: `enc:${await encryptCredentials("password_test", key)}` },
        { key: "enabled", value: "true" },
      ],
    ]);
    const polarDb = createDbReturningCategoryReads([
      [
        { key: "access_token", value: `enc:${await encryptCredentials("polar_token", key)}` },
        { key: "product_id", value: "polar_product" },
        { key: "webhook_secret", value: `enc:${await encryptCredentials("polar_webhook", key)}` },
        { key: "enabled", value: "true" },
      ],
    ]);

    const stripe = await getStripeSettings(stripeDb as never, undefined, wrongKey, {
      bypassMemoryCache: true,
    });
    const ssl = await getSSLCommerzSettings(sslDb as never, undefined, wrongKey, {
      bypassMemoryCache: true,
    });
    const polar = await getPolarSettings(polarDb as never, undefined, wrongKey, {
      bypassMemoryCache: true,
    });

    expect(getStripeCheckoutReadiness(stripe)).toMatchObject({
      configured: false,
      usable: false,
      credentialErrors: [
        "Stripe secret key could not be decrypted with the configured credential key.",
        "Stripe webhook secret could not be decrypted with the configured credential key.",
      ],
      blockedReason: "Stripe secret key could not be decrypted with the configured credential key.",
    });
    expect(getSSLCommerzCheckoutReadiness(ssl)).toMatchObject({
      configured: false,
      usable: false,
      credentialErrors: [
        "SSLCommerz store password could not be decrypted with the configured credential key.",
      ],
    });
    expect(getPolarCheckoutReadiness(polar)).toMatchObject({
      configured: false,
      usable: false,
      credentialErrors: [
        "Polar access token could not be decrypted with the configured credential key.",
        "Polar webhook secret could not be decrypted with the configured credential key.",
      ],
    });
  });

  it("reports exact SSLCommerz and Polar checkout readiness gaps", () => {
    expect(getSSLCommerzCheckoutReadiness({
      storeId: "store_1",
      storePassword: "",
      enabled: true,
    })).toMatchObject({
      configured: false,
      enabled: true,
      usable: false,
      missingFields: ["storePassword"],
      blockedReason: expect.stringContaining("store password"),
    });
    expect(getPolarCheckoutReadiness({
      accessToken: "polar_token",
      productId: "product_1",
      webhookSecret: "",
      enabled: true,
    })).toMatchObject({
      configured: false,
      enabled: true,
      usable: false,
      missingFields: ["webhookSecret"],
      blockedReason: expect.stringContaining("webhook secret"),
    });
  });

  it("keeps Stripe active when every checkout-required key is present", async () => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["stripe"]) },
        { key: "default_method", value: "stripe" },
      ],
      [
        { key: "secret_key", value: "sk_live_secret" },
        { key: "publishable_key", value: "pk_live_public" },
        { key: "webhook_secret", value: "whsec_live" },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(
      getActivePaymentMethods(db as never, undefined, undefined, {
        bypassMemoryCache: true,
      }),
    ).resolves.toEqual({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
  });

  it("fails closed instead of storing provider secrets without an encryption key", async () => {
    const { db } = createDbCapturingInsert();

    await expect(
      upsertEncryptedSetting(db as never, "stripe", "secret_key", "sk_live_missing_key"),
    ).rejects.toThrow("CREDENTIAL_ENCRYPTION_KEY is required");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("encrypts provider secrets before writing them to settings", async () => {
    const { db, captured } = createDbCapturingInsert();
    const key = Buffer.alloc(32, 7).toString("base64");

    await upsertEncryptedSetting(db as never, "stripe", "secret_key", "sk_live_secret", key);

    expect(captured.values).toMatchObject({
      category: "stripe",
      key: "secret_key",
      type: "string",
    });
    expect(captured.values?.value).toEqual(expect.any(String));
    expect(captured.values?.value).toMatch(/^enc:/);
    expect(captured.values?.value).not.toBe("sk_live_secret");
    await expect(
      decryptCredentials(String(captured.values?.value).slice("enc:".length), key),
    ).resolves.toBe("sk_live_secret");
  });
});
