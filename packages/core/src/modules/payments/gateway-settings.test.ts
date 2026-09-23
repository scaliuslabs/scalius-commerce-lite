import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import {
  getActivePaymentMethods,
  getSSLCommerzSettings,
  getSSLCommerzCheckoutReadiness,
  isSSLCommerzPlaceholderCredential,
  getStripeSettings,
  getStripeCheckoutReadiness,
  isStripePlaceholderCredential,
  resolveActivePaymentMethodsFromRows,
} from "./gateway-settings";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import { encryptCredentials } from "../../utils/credential-encryption";

type LegacyRow = { category?: string; key: string; value: string };

const STRIPE_FIELDS: Record<string, string> = {
  secret_key: "secretKey",
  publishable_key: "publishableKey",
  webhook_secret: "webhookSecret",
};
const SSLCOMMERZ_FIELDS: Record<string, string> = { store_id: "storeId", store_password: "storePassword" };

function categoryOf(rows: LegacyRow[]): string | null {
  if (rows.some((row) => row.key in STRIPE_FIELDS)) return "stripe";
  if (rows.some((row) => row.key in SSLCOMMERZ_FIELDS || row.key === "sandbox")) return "sslcommerz";
  if (rows.some((row) => row.key === "enabled_methods" || row.key === "default_method")) return "payment_methods";
  return null;
}

/** The documents the 0065 migration builds from these per-key fixture rows. */
function documentFor(category: string, rows: LegacyRow[]): Record<string, unknown> {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (category === "payment_methods") {
    let enabledMethods: unknown = null;
    if (values.enabled_methods !== undefined) {
      try {
        enabledMethods = JSON.parse(values.enabled_methods);
      } catch {
        enabledMethods = [];
      }
    }
    return { enabledMethods, defaultMethod: values.default_method ?? "cod" };
  }
  const fields = category === "stripe" ? STRIPE_FIELDS : SSLCOMMERZ_FIELDS;
  return {
    ...Object.fromEntries(rows.filter((row) => row.key in fields).map((row) => [fields[row.key], row.value])),
    ...(values.sandbox !== undefined ? { sandbox: values.sandbox !== "false" } : {}),
    ...(values.enabled !== undefined ? { enabled: values.enabled !== "false" } : {}),
  };
}

function documentRows(rows: LegacyRow[]) {
  const byCategory = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    const category = row.category ?? categoryOf([row]);
    if (category) byCategory.set(category, [...(byCategory.get(category) ?? []), row]);
  }
  return [...byCategory].map(([category, categoryRows]) => ({
    category,
    value: JSON.stringify(documentFor(category, categoryRows)),
    revision: 1,
  }));
}

/** Each group of fixture rows is one gateway settings document. */
function createDbReturningCategoryReads(groups: LegacyRow[][]) {
  const { db, sqlite } = createSqliteD1Database();
  for (const rows of groups) {
    const category = categoryOf(rows);
    if (!category) continue;
    sqlite.prepare("INSERT INTO settings (id, key, value, type, category) VALUES (?, 'document', ?, 'json', ?)")
      .run(category, JSON.stringify(documentFor(category, rows)), category);
  }
  return db;
}

describe("payment gateway settings reads", () => {
  it("does not retain decrypted gateway credentials across requests", async () => {
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

    await expect(getStripeSettings(oldDb)).resolves.toMatchObject({
      secretKey: "sk_old",
      publishableKey: "pk_old",
      enabled: true,
    });

    await expect(getStripeSettings(freshDb)).resolves.toMatchObject({
      secretKey: "sk_new",
      publishableKey: "pk_new",
      enabled: false,
    });
  });

  it("does not retain payment-method allowlists across requests", async () => {
    const oldDb = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["cod"]) },
        { key: "default_method", value: "cod" },
      ],
    ]);
    const freshDb = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["stripe"]) },
        { key: "default_method", value: "stripe" },
      ],
      [],
    ]);

    await expect(getActivePaymentMethods(oldDb)).resolves.toEqual({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
    });

    await expect(getActivePaymentMethods(freshDb)).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it("deduplicates legacy payment-method lists while preserving their saved order", async () => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["cod", "cod"]) },
        { key: "default_method", value: "cod" },
      ],
    ]);

    await expect(getActivePaymentMethods(db)).resolves.toEqual({
      enabledMethods: ["cod"],
      defaultMethod: "cod",
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
      getActivePaymentMethods(db),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it("fails closed for a stored payment-method document that is not JSON", async () => {
    const { db, sqlite } = createSqliteD1Database();
    sqlite.exec("INSERT INTO settings (id, key, value, type, category) VALUES ('pm', 'document', '{not json', 'json', 'payment_methods')");

    await expect(getActivePaymentMethods(db)).resolves.toEqual({ enabledMethods: [], defaultMethod: "cod" });
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
      getActivePaymentMethods(db),
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
      getActivePaymentMethods(db, wrongKey),
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

    const stripe = await getStripeSettings(stripeDb, wrongKey);
    const ssl = await getSSLCommerzSettings(sslDb, wrongKey);

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
  });

  it("reports exact SSLCommerz checkout readiness gaps", () => {
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
  });

  it.each([
    "dummy",
    "placeholder",
    "example",
    "demo",
    "test",
    "stripe_secret_key",
    "stripe_publishable_key",
    "stripe_webhook_secret",
    "your_stripe_secret_key",
    "your_stripe_publishable_key",
    "your_stripe_webhook_secret",
    "sk_test_your_key_here",
    "pk_test_your_key_here",
    "whsec_your_webhook_secret",
  ])("treats %s as a Stripe placeholder credential", (value) => {
    expect(isStripePlaceholderCredential(` ${value.toUpperCase()} `)).toBe(true);
  });

  it("does not reject real-looking Stripe test-mode keys by prefix", () => {
    expect(isStripePlaceholderCredential("sk_test_51_realishValue")).toBe(false);
    expect(isStripePlaceholderCredential("pk_test_realishValue")).toBe(false);
    expect(isStripePlaceholderCredential("sk_test")).toBe(false);
    expect(getStripeCheckoutReadiness({
      secretKey: "sk_test",
      publishableKey: "pk_test",
      webhookSecret: "whsec_test",
      enabled: true,
    })).toMatchObject({
      configured: true,
      usable: true,
      credentialErrors: [],
    });
  });

  it("rejects a mixed Stripe test/live key pair", () => {
    expect(getStripeCredentialEnvironment({
      secretKey: "sk_test_51_realishValue",
      publishableKey: "pk_live_realishValue",
    })).toBe("mixed");
    expect(getStripeCheckoutReadiness({
      secretKey: "sk_test_51_realishValue",
      publishableKey: "pk_live_realishValue",
      webhookSecret: "whsec_realishValue",
      enabled: true,
    })).toMatchObject({
      configured: false,
      usable: false,
      blockedReason: "Stripe secret and publishable keys use different test/live environments. Choose a matching key pair.",
    });
  });

  it("blocks Stripe checkout readiness when credentials are placeholders", () => {
    expect(getStripeCheckoutReadiness({
      secretKey: "stripe_secret_key",
      publishableKey: "pk_test_your_key_here",
      webhookSecret: "whsec_your_webhook_secret",
      enabled: true,
    })).toMatchObject({
      configured: false,
      enabled: true,
      usable: false,
      missingFields: [],
      credentialErrors: [
        "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account.",
        "Stripe publishable key looks like a placeholder. Enter the real Stripe publishable key from your merchant account.",
        "Stripe webhook secret looks like a placeholder. Enter the real Stripe webhook secret from your merchant account.",
      ],
      blockedReason: "Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account.",
    });
  });

  it("does not make Stripe active with placeholder credentials", async () => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["stripe"]) },
        { key: "default_method", value: "stripe" },
      ],
      [
        { key: "secret_key", value: "sk_test_your_key_here" },
        { key: "publishable_key", value: "pk_live_public" },
        { key: "webhook_secret", value: "whsec_live" },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(
      getActivePaymentMethods(db),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
    });
  });

  it.each([
    "dummy",
    "test",
    "testbox",
    "qwerty",
    "password",
    "store_id",
    "storeid",
    "store_password",
    "storepass",
    "example",
    "placeholder",
    "demo",
    "123456",
    "000000",
    "xxxxxx",
    "__stored__",
  ])("treats %s as an SSLCommerz placeholder credential", (value) => {
    expect(isSSLCommerzPlaceholderCredential(` ${value.toUpperCase()} `)).toBe(true);
  });

  it("does not reject real-looking SSLCommerz sandbox credential names by substring", () => {
    expect(isSSLCommerzPlaceholderCredential("sandbox")).toBe(false);
    expect(isSSLCommerzPlaceholderCredential("sslcz_sandbox_store_123")).toBe(false);
  });

  it("accepts SSLCommerz's published testbox account only in sandbox mode", () => {
    expect(getSSLCommerzCheckoutReadiness({
      storeId: "testbox",
      storePassword: "qwerty",
      sandbox: true,
      enabled: true,
    })).toMatchObject({ configured: true, usable: true, credentialErrors: [] });

    expect(getSSLCommerzCheckoutReadiness({
      storeId: "testbox",
      storePassword: "qwerty",
      sandbox: false,
      enabled: true,
    })).toMatchObject({ configured: false, usable: false });
  });

  it("blocks SSLCommerz checkout readiness when credentials are placeholders", () => {
    expect(getSSLCommerzCheckoutReadiness({
      storeId: "store_id",
      storePassword: "password",
      enabled: true,
    })).toMatchObject({
      configured: false,
      enabled: true,
      usable: false,
      missingFields: [],
      credentialErrors: [
        "SSLCommerz store ID looks like a placeholder. Enter the real SSLCommerz store ID from your merchant account.",
        "SSLCommerz store password looks like a placeholder. Enter the real SSLCommerz store password from your merchant account.",
      ],
      blockedReason: "SSLCommerz store ID looks like a placeholder. Enter the real SSLCommerz store ID from your merchant account.",
    });
  });

  it("does not make SSLCommerz active with placeholder credentials", async () => {
    const db = createDbReturningCategoryReads([
      [
        { key: "enabled_methods", value: JSON.stringify(["sslcommerz"]) },
        { key: "default_method", value: "sslcommerz" },
      ],
      [
        { key: "store_id", value: "real_store_123" },
        { key: "store_password", value: "password" },
        { key: "enabled", value: "true" },
      ],
    ]);

    await expect(
      getActivePaymentMethods(db),
    ).resolves.toEqual({
      enabledMethods: [],
      defaultMethod: "cod",
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
      getActivePaymentMethods(db),
    ).resolves.toEqual({
      enabledMethods: ["stripe"],
      defaultMethod: "stripe",
    });
  });

  it("resolves the same strict gateway allowlist from one preloaded settings snapshot", async () => {
    const rows = [
      { category: "payment_methods", key: "enabled_methods", value: JSON.stringify(["cod", "stripe", "sslcommerz"]) },
      { category: "payment_methods", key: "default_method", value: "stripe" },
      { category: "stripe", key: "secret_key", value: "sk_live_snapshot_secret" },
      { category: "stripe", key: "publishable_key", value: "pk_live_snapshot_public" },
      { category: "stripe", key: "webhook_secret", value: "whsec_snapshot" },
      { category: "stripe", key: "enabled", value: "true" },
      { category: "sslcommerz", key: "store_id", value: "sslcz_snapshot_store_123" },
      { category: "sslcommerz", key: "store_password", value: "sslcz_snapshot_password_123" },
      { category: "sslcommerz", key: "enabled", value: "true" },
    ];

    await expect(resolveActivePaymentMethodsFromRows(documentRows(rows))).resolves.toEqual({
      enabledMethods: ["cod", "stripe", "sslcommerz"],
      defaultMethod: "stripe",
    });
  });
});
