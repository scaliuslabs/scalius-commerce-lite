// src/modules/payments/gateway-settings.ts
// Reads payment gateway credentials from the `settings` DB table.
// Results are cached in KV for 5 minutes to avoid a DB hit on every request.
//
// Settings are set by the admin dashboard (not environment variables).

import { eq } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { registerGateway } from "./gateway-registry";
import { encryptCredentials, decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";

const CACHE_TTL = 300; // 5 minutes

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StripeSettings {
  secretKey: string;
  publishableKey: string;
  webhookSecret: string;
  enabled: boolean;
}

export interface SSLCommerzSettings {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
  enabled: boolean;
}

export interface PolarSettings {
  accessToken: string;
  webhookSecret: string;
  productId: string;
  sandbox: boolean;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Generic helper: bulk-read all keys for a category
// ---------------------------------------------------------------------------

async function readCategory(
  db: Database,
  category: string
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, category))
    .all();

  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const STRIPE_CATEGORY = "stripe";
const STRIPE_CACHE_KEY = "gw:stripe";

export async function getStripeSettings(
  db: Database,
  kv?: KVNamespace,
  encryptionKey?: string
): Promise<StripeSettings | null> {
  // Try KV cache first (stores decrypted values)
  if (kv) {
    const cached = await kv.get<StripeSettings>(STRIPE_CACHE_KEY, "json");
    if (cached) return cached;
  }

  const values = await readCategory(db, STRIPE_CATEGORY);
  if (!values.secret_key || !values.webhook_secret) return null;

  const stripeSettings: StripeSettings = {
    secretKey: await decryptCredentialsGraceful(values.secret_key, encryptionKey),
    publishableKey: values.publishable_key ?? "",
    webhookSecret: await decryptCredentialsGraceful(values.webhook_secret, encryptionKey),
    enabled: values.enabled !== "false",
  };

  // Cache in KV (decrypted — KV is ephemeral, not at-rest)
  if (kv) {
    await kv.put(STRIPE_CACHE_KEY, JSON.stringify(stripeSettings), {
      expirationTtl: CACHE_TTL,
    });
  }

  return stripeSettings;
}

/** Invalidate the Stripe settings KV cache (call after saving new settings). */
export async function invalidateStripeCache(kv?: KVNamespace): Promise<void> {
  await kv?.delete(STRIPE_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// SSLCommerz
// ---------------------------------------------------------------------------

const SSL_CATEGORY = "sslcommerz";
const SSL_CACHE_KEY = "gw:sslcommerz";

export async function getSSLCommerzSettings(
  db: Database,
  kv?: KVNamespace,
  encryptionKey?: string
): Promise<SSLCommerzSettings | null> {
  if (kv) {
    const cached = await kv.get<SSLCommerzSettings>(SSL_CACHE_KEY, "json");
    if (cached) return cached;
  }

  const values = await readCategory(db, SSL_CATEGORY);
  if (!values.store_id || !values.store_password) return null;

  const sslSettings: SSLCommerzSettings = {
    storeId: values.store_id,
    storePassword: await decryptCredentialsGraceful(values.store_password, encryptionKey),
    sandbox: values.sandbox !== "false",
    enabled: values.enabled !== "false",
  };

  if (kv) {
    await kv.put(SSL_CACHE_KEY, JSON.stringify(sslSettings), {
      expirationTtl: CACHE_TTL,
    });
  }

  return sslSettings;
}

/** Invalidate the SSLCommerz settings KV cache. */
export async function invalidateSSLCommerzCache(kv?: KVNamespace): Promise<void> {
  await kv?.delete(SSL_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Polar
// ---------------------------------------------------------------------------

const POLAR_CATEGORY = "polar";
const POLAR_CACHE_KEY = "gw:polar";

export async function getPolarSettings(
  db: Database,
  kv?: KVNamespace,
  encryptionKey?: string
): Promise<PolarSettings | null> {
  if (kv) {
    const cached = await kv.get<PolarSettings>(POLAR_CACHE_KEY, "json");
    if (cached) return cached;
  }

  const values = await readCategory(db, POLAR_CATEGORY);
  if (!values.access_token || !values.product_id) return null;

  const polarSettings: PolarSettings = {
    accessToken: await decryptCredentialsGraceful(values.access_token, encryptionKey),
    webhookSecret: values.webhook_secret
      ? await decryptCredentialsGraceful(values.webhook_secret, encryptionKey)
      : "",
    productId: values.product_id,
    sandbox: values.sandbox !== "false",
    enabled: values.enabled !== "false",
  };

  if (kv) {
    await kv.put(POLAR_CACHE_KEY, JSON.stringify(polarSettings), {
      expirationTtl: CACHE_TTL,
    });
  }

  return polarSettings;
}

/** Invalidate the Polar settings KV cache. */
export async function invalidatePolarCache(kv?: KVNamespace): Promise<void> {
  await kv?.delete(POLAR_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Upsert helpers (used by admin API routes)
// ---------------------------------------------------------------------------

export async function upsertSetting(
  db: Database,
  category: string,
  key: string,
  value: string
): Promise<void> {
  await db
    .insert(settings)
    .values({
      id: crypto.randomUUID(),
      key,
      value,
      type: "string",
      category,
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: { value, updatedAt: new Date() },
    });
}

/** Encrypt a value then upsert it. Falls back to plaintext if no key. */
export async function upsertEncryptedSetting(
  db: Database,
  category: string,
  key: string,
  value: string,
  encryptionKey?: string,
): Promise<void> {
  const stored = encryptionKey
    ? await encryptCredentials(value, encryptionKey)
    : value;
  await upsertSetting(db, category, key, stored);
}

// ---------------------------------------------------------------------------
// Payment Methods Configuration (storefront-facing)
// ---------------------------------------------------------------------------

const PAYMENT_METHODS_CATEGORY = "payment_methods";
const PAYMENT_METHODS_CACHE_KEY = "gw:payment_methods";

export interface PaymentMethodsConfig {
  /** Which payment methods are enabled for the storefront */
  enabledMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[];
  /** Default payment method shown first on checkout */
  defaultMethod: "stripe" | "sslcommerz" | "polar" | "cod";
}

/**
 * Get active payment methods for the storefront.
 *
 * Reads the admin's configuration AND cross-checks that each gateway
 * actually has valid credentials configured. A method is only returned
 * if it's both enabled AND has credentials (COD always works).
 */
export async function getActivePaymentMethods(
  db: Database,
  kv?: KVNamespace,
  encryptionKey?: string
): Promise<PaymentMethodsConfig> {
  // Try cache
  if (kv) {
    const cached = await kv.get<PaymentMethodsConfig>(PAYMENT_METHODS_CACHE_KEY, "json");
    if (cached) return cached;
  }

  // Read payment methods settings
  const values = await readCategory(db, PAYMENT_METHODS_CATEGORY);

  // Parse enabled methods (default: COD only)
  let enabledMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[];
  try {
    enabledMethods = values.enabled_methods
      ? JSON.parse(values.enabled_methods)
      : ["cod"];
  } catch {
    enabledMethods = ["cod"];
  }

  const defaultMethod = (values.default_method as PaymentMethodsConfig["defaultMethod"]) ?? "cod";

  // Cross-check: only include methods with valid credentials
  const validMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[] = [];

  for (const method of enabledMethods) {
    if (method === "cod") {
      validMethods.push("cod");
      continue;
    }
    if (method === "stripe") {
      const stripe = await getStripeSettings(db, undefined, encryptionKey); // skip KV — we're already building cache
      if (stripe && stripe.enabled) {
        validMethods.push("stripe");
      }
    }
    if (method === "sslcommerz") {
      const ssl = await getSSLCommerzSettings(db, undefined, encryptionKey);
      if (ssl && ssl.enabled) {
        validMethods.push("sslcommerz");
      }
    }
    if (method === "polar") {
      const polar = await getPolarSettings(db, undefined, encryptionKey);
      if (polar && polar.enabled) {
        validMethods.push("polar");
      }
    }
  }

  // Ensure at least COD is available
  if (validMethods.length === 0) {
    validMethods.push("cod");
  }

  const config: PaymentMethodsConfig = {
    enabledMethods: validMethods,
    defaultMethod: validMethods.includes(defaultMethod) ? defaultMethod : (validMethods[0] ?? "cod"),
  };

  // Cache
  if (kv) {
    await kv.put(PAYMENT_METHODS_CACHE_KEY, JSON.stringify(config), {
      expirationTtl: CACHE_TTL,
    });
  }

  return config;
}

/** Invalidate payment methods cache (call when admin saves changes). */
export async function invalidatePaymentMethodsCache(kv?: KVNamespace): Promise<void> {
  await kv?.delete(PAYMENT_METHODS_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Gateway Registry — register each gateway's metadata
// ---------------------------------------------------------------------------

registerGateway({
  id: "stripe",
  name: "Card Payment",
  settingsCategory: STRIPE_CATEGORY,
  getSettings: async (db, kv, encryptionKey) => {
    const s = await getStripeSettings(db, kv, encryptionKey);
    return s ? { ...s, enabled: s.enabled } : null;
  },
  getPublicConfig: (s) => ({
    publishableKey: s.publishableKey,
  }),
  getCurrencies: (localCurrency) => [localCurrency, "usd", "eur", "gbp"],
});

registerGateway({
  id: "sslcommerz",
  name: "Online Payment",
  settingsCategory: SSL_CATEGORY,
  getSettings: async (db, kv, encryptionKey) => {
    const s = await getSSLCommerzSettings(db, kv, encryptionKey);
    return s ? { ...s, enabled: s.enabled } : null;
  },
  getPublicConfig: (s) => ({
    sandbox: s.sandbox,
  }),
  getCurrencies: (localCurrency) => [localCurrency],
});

registerGateway({
  id: "polar",
  name: "Polar",
  settingsCategory: POLAR_CATEGORY,
  getSettings: async (db, kv, encryptionKey) => {
    const s = await getPolarSettings(db, kv, encryptionKey);
    return s ? { ...s, enabled: s.enabled } : null;
  },
  getPublicConfig: (s) => ({
    sandbox: s.sandbox,
  }),
  getCurrencies: (localCurrency) => [localCurrency, "usd"],
});

registerGateway({
  id: "cod",
  name: "Cash on Delivery",
  settingsCategory: "cod",
  getSettings: async () => ({ enabled: true }),
  getCurrencies: (localCurrency) => [localCurrency],
});
