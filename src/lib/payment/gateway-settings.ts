// src/lib/payment/gateway-settings.ts
// Reads payment gateway credentials from the `settings` DB table.
// Results are cached in KV for 5 minutes to avoid a DB hit on every request.
//
// Settings are set by the admin dashboard (not environment variables).

import { eq, and } from "drizzle-orm";
import { settings } from "@/db/schema";
import type { Database } from "@/db";

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
  kv?: KVNamespace
): Promise<StripeSettings | null> {
  // Try KV cache first
  if (kv) {
    const cached = await kv.get<StripeSettings>(STRIPE_CACHE_KEY, "json");
    if (cached) return cached;
  }

  const values = await readCategory(db, STRIPE_CATEGORY);
  if (!values.secret_key || !values.webhook_secret) return null;

  const stripeSettings: StripeSettings = {
    secretKey: values.secret_key,
    publishableKey: values.publishable_key ?? "",
    webhookSecret: values.webhook_secret,
    enabled: values.enabled !== "false",
  };

  // Cache in KV
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
  kv?: KVNamespace
): Promise<SSLCommerzSettings | null> {
  if (kv) {
    const cached = await kv.get<SSLCommerzSettings>(SSL_CACHE_KEY, "json");
    if (cached) return cached;
  }

  const values = await readCategory(db, SSL_CATEGORY);
  if (!values.store_id || !values.store_password) return null;

  const sslSettings: SSLCommerzSettings = {
    storeId: values.store_id,
    storePassword: values.store_password,
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

// ---------------------------------------------------------------------------
// Payment Methods Configuration (storefront-facing)
// ---------------------------------------------------------------------------

const PAYMENT_METHODS_CATEGORY = "payment_methods";
const PAYMENT_METHODS_CACHE_KEY = "gw:payment_methods";

export interface PaymentMethodsConfig {
  /** Which payment methods are enabled for the storefront */
  enabledMethods: ("stripe" | "sslcommerz" | "cod")[];
  /** Default payment method shown first on checkout */
  defaultMethod: "stripe" | "sslcommerz" | "cod";
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
  kv?: KVNamespace
): Promise<PaymentMethodsConfig> {
  // Try cache
  if (kv) {
    const cached = await kv.get<PaymentMethodsConfig>(PAYMENT_METHODS_CACHE_KEY, "json");
    if (cached) return cached;
  }

  // Read payment methods settings
  const values = await readCategory(db, PAYMENT_METHODS_CATEGORY);

  // Parse enabled methods (default: COD only)
  let enabledMethods: ("stripe" | "sslcommerz" | "cod")[];
  try {
    enabledMethods = values.enabled_methods
      ? JSON.parse(values.enabled_methods)
      : ["cod"];
  } catch {
    enabledMethods = ["cod"];
  }

  const defaultMethod = (values.default_method as PaymentMethodsConfig["defaultMethod"]) ?? "cod";

  // Cross-check: only include methods with valid credentials
  const validMethods: ("stripe" | "sslcommerz" | "cod")[] = [];

  for (const method of enabledMethods) {
    if (method === "cod") {
      validMethods.push("cod");
      continue;
    }
    if (method === "stripe") {
      const stripe = await getStripeSettings(db); // skip KV — we're already building cache
      if (stripe && stripe.enabled) {
        validMethods.push("stripe");
      }
    }
    if (method === "sslcommerz") {
      const ssl = await getSSLCommerzSettings(db);
      if (ssl && ssl.enabled) {
        validMethods.push("sslcommerz");
      }
    }
  }

  // Ensure at least COD is available
  if (validMethods.length === 0) {
    validMethods.push("cod");
  }

  const config: PaymentMethodsConfig = {
    enabledMethods: validMethods,
    defaultMethod: validMethods.includes(defaultMethod) ? defaultMethod : validMethods[0],
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
