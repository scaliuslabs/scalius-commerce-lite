// src/modules/payments/gateway-settings.ts
// Reads payment gateway credentials from the `settings` DB table.
// Results are cached in-memory (per isolate) for 5 minutes.
//
// SECURITY: Decrypted credentials are NEVER written to KV or any persistent
// store. In-memory cache is scoped to the Worker isolate lifetime and is
// automatically cleared on cold start — this is the correct behavior.
//
// Settings are set by the admin dashboard (not environment variables).

import { eq, sql } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { GatewaySettingsReadOptions } from "./gateway-registry";
import { registerGateway } from "./gateway-registry";
import { encryptCredentials, decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";

// ---------------------------------------------------------------------------
// In-memory credential cache (per-isolate, lost on cold start)
// ---------------------------------------------------------------------------

export const FRESH_GATEWAY_SETTINGS_READ_OPTIONS = {
  bypassMemoryCache: true,
} as const satisfies GatewaySettingsReadOptions;

const credentialCache = new Map<string, { data: unknown; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedCredential<T>(key: string): T | null {
  const entry = credentialCache.get(key);
  if (entry && Date.now() < entry.expiry) return entry.data as T;
  credentialCache.delete(key);
  return null;
}

function setCachedCredential(key: string, data: unknown): void {
  credentialCache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

function invalidateCachedCredential(key: string): void {
  credentialCache.delete(key);
}

async function deleteLegacyCredentialKv(
  kv: KVNamespace | undefined,
  key: string,
): Promise<void> {
  if (!kv) return;
  try {
    await kv.delete(key);
  } catch (error: unknown) {
    console.warn(
      `[Payments] Legacy KV credential cache delete failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

async function cleanupLegacyCredentialKv(
  kv: KVNamespace | undefined,
  key: string,
): Promise<void> {
  if (!kv) return;
  try {
    const kvEntry = await kv.get(key);
    if (kvEntry) {
      await deleteLegacyCredentialKv(kv, key);
    }
  } catch (error: unknown) {
    console.warn(
      `[Payments] Legacy KV credential cache lookup failed for ${key}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

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
  encryptionKey?: string,
  options: GatewaySettingsReadOptions = {},
): Promise<StripeSettings | null> {
  // Try in-memory cache first
  if (!options.bypassMemoryCache) {
    const cached = getCachedCredential<StripeSettings>(STRIPE_CACHE_KEY);
    if (cached) return cached;
  }

  // Migration path: if KV has a stale entry from before this fix, delete it.
  await cleanupLegacyCredentialKv(kv, STRIPE_CACHE_KEY);

  const values = await readCategory(db, STRIPE_CATEGORY);
  if (!values.secret_key || !values.webhook_secret) return null;

  const stripeSettings: StripeSettings = {
    secretKey: await decryptCredentialsGraceful(values.secret_key, encryptionKey),
    publishableKey: values.publishable_key ?? "",
    webhookSecret: await decryptCredentialsGraceful(values.webhook_secret, encryptionKey),
    enabled: values.enabled !== "false",
  };

  // Cache in memory only — never persist decrypted credentials
  if (!options.bypassMemoryCache) {
    setCachedCredential(STRIPE_CACHE_KEY, stripeSettings);
  }

  return stripeSettings;
}

/** Invalidate the Stripe settings cache (call after saving new settings). */
export async function invalidateStripeCache(kv?: KVNamespace): Promise<void> {
  invalidateCachedCredential(STRIPE_CACHE_KEY);
  // Also clean up any legacy KV entries
  await deleteLegacyCredentialKv(kv, STRIPE_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// SSLCommerz
// ---------------------------------------------------------------------------

const SSL_CATEGORY = "sslcommerz";
const SSL_CACHE_KEY = "gw:sslcommerz";

export async function getSSLCommerzSettings(
  db: Database,
  kv?: KVNamespace,
  encryptionKey?: string,
  options: GatewaySettingsReadOptions = {},
): Promise<SSLCommerzSettings | null> {
  // Try in-memory cache first
  if (!options.bypassMemoryCache) {
    const cached = getCachedCredential<SSLCommerzSettings>(SSL_CACHE_KEY);
    if (cached) return cached;
  }

  // Migration path: clean up stale KV entries.
  await cleanupLegacyCredentialKv(kv, SSL_CACHE_KEY);

  const values = await readCategory(db, SSL_CATEGORY);
  if (!values.store_id || !values.store_password) return null;

  const sslSettings: SSLCommerzSettings = {
    storeId: values.store_id,
    storePassword: await decryptCredentialsGraceful(values.store_password, encryptionKey),
    sandbox: values.sandbox !== "false",
    enabled: values.enabled !== "false",
  };

  // Cache in memory only — never persist decrypted credentials
  if (!options.bypassMemoryCache) {
    setCachedCredential(SSL_CACHE_KEY, sslSettings);
  }

  return sslSettings;
}

/** Invalidate the SSLCommerz settings cache. */
export async function invalidateSSLCommerzCache(kv?: KVNamespace): Promise<void> {
  invalidateCachedCredential(SSL_CACHE_KEY);
  // Also clean up any legacy KV entries
  await deleteLegacyCredentialKv(kv, SSL_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Polar
// ---------------------------------------------------------------------------

const POLAR_CATEGORY = "polar";
const POLAR_CACHE_KEY = "gw:polar";

export async function getPolarSettings(
  db: Database,
  kv?: KVNamespace,
  encryptionKey?: string,
  options: GatewaySettingsReadOptions = {},
): Promise<PolarSettings | null> {
  // Try in-memory cache first
  if (!options.bypassMemoryCache) {
    const cached = getCachedCredential<PolarSettings>(POLAR_CACHE_KEY);
    if (cached) return cached;
  }

  // Migration path: clean up stale KV entries.
  await cleanupLegacyCredentialKv(kv, POLAR_CACHE_KEY);

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

  // Cache in memory only — never persist decrypted credentials
  if (!options.bypassMemoryCache) {
    setCachedCredential(POLAR_CACHE_KEY, polarSettings);
  }

  return polarSettings;
}

/** Invalidate the Polar settings cache. */
export async function invalidatePolarCache(kv?: KVNamespace): Promise<void> {
  invalidateCachedCredential(POLAR_CACHE_KEY);
  // Also clean up any legacy KV entries
  await deleteLegacyCredentialKv(kv, POLAR_CACHE_KEY);
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
      set: { value, updatedAt: sql`unixepoch()` },
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
  encryptionKey?: string,
  options: GatewaySettingsReadOptions = {},
): Promise<PaymentMethodsConfig> {
  // Try in-memory cache first
  if (!options.bypassMemoryCache) {
    const cached = getCachedCredential<PaymentMethodsConfig>(PAYMENT_METHODS_CACHE_KEY);
    if (cached) return cached;
  }

  // Migration path: clean up stale KV entries
  if (kv) {
    const kvEntry = await kv.get(PAYMENT_METHODS_CACHE_KEY);
    if (kvEntry) await kv.delete(PAYMENT_METHODS_CACHE_KEY);
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
      const stripe = await getStripeSettings(db, kv, encryptionKey, options);
      if (stripe && stripe.enabled) {
        validMethods.push("stripe");
      }
    }
    if (method === "sslcommerz") {
      const ssl = await getSSLCommerzSettings(db, kv, encryptionKey, options);
      if (ssl && ssl.enabled) {
        validMethods.push("sslcommerz");
      }
    }
    if (method === "polar") {
      const polar = await getPolarSettings(db, kv, encryptionKey, options);
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

  // Cache in memory only
  if (!options.bypassMemoryCache) {
    setCachedCredential(PAYMENT_METHODS_CACHE_KEY, config);
  }

  return config;
}

/** Invalidate payment methods cache (call when admin saves changes). */
export async function invalidatePaymentMethodsCache(kv?: KVNamespace): Promise<void> {
  invalidateCachedCredential(PAYMENT_METHODS_CACHE_KEY);
  // Also clean up any legacy KV entries
  await deleteLegacyCredentialKv(kv, PAYMENT_METHODS_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// Gateway Registry — register each gateway's metadata
// ---------------------------------------------------------------------------

registerGateway({
  id: "stripe",
  name: "Card Payment",
  settingsCategory: STRIPE_CATEGORY,
  getSettings: async (db, kv, encryptionKey, options) => {
    const s = await getStripeSettings(db, kv, encryptionKey, options);
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
  getSettings: async (db, kv, encryptionKey, options) => {
    const s = await getSSLCommerzSettings(db, kv, encryptionKey, options);
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
  getSettings: async (db, kv, encryptionKey, options) => {
    const s = await getPolarSettings(db, kv, encryptionKey, options);
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
