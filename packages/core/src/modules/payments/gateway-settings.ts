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
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import type { GatewaySettingsReadOptions } from "./gateway-registry";
import { registerGateway } from "./gateway-registry";
import {
  encodeEncryptedCredential,
  encryptCredentials,
  readStoredCredentialStrict,
} from "@scalius/core/utils/credential-encryption";

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
  credentialErrors?: string[];
}

export type StripeCheckoutRequiredField = "secretKey" | "publishableKey" | "webhookSecret";

const STRIPE_CHECKOUT_FIELD_LABELS: Record<StripeCheckoutRequiredField, string> = {
  secretKey: "secret key",
  publishableKey: "publishable key",
  webhookSecret: "webhook secret",
};

export interface StripeCheckoutReadiness {
  configured: boolean;
  enabled: boolean;
  usable: boolean;
  missingFields: StripeCheckoutRequiredField[];
  credentialErrors?: string[];
  blockedReason?: string;
}

export interface SSLCommerzSettings {
  storeId: string;
  storePassword: string;
  sandbox: boolean;
  enabled: boolean;
  credentialErrors?: string[];
}

export type SSLCommerzCheckoutRequiredField = "storeId" | "storePassword";

const SSLCOMMERZ_CHECKOUT_FIELD_LABELS: Record<SSLCommerzCheckoutRequiredField, string> = {
  storeId: "store ID",
  storePassword: "store password",
};

export interface SSLCommerzCheckoutReadiness {
  configured: boolean;
  enabled: boolean;
  usable: boolean;
  missingFields: SSLCommerzCheckoutRequiredField[];
  credentialErrors?: string[];
  blockedReason?: string;
}

export interface PolarSettings {
  accessToken: string;
  webhookSecret: string;
  productId: string;
  sandbox: boolean;
  enabled: boolean;
  credentialErrors?: string[];
}

export type PolarCheckoutRequiredField = "accessToken" | "productId" | "webhookSecret";

const POLAR_CHECKOUT_FIELD_LABELS: Record<PolarCheckoutRequiredField, string> = {
  accessToken: "access token",
  productId: "product ID",
  webhookSecret: "webhook secret",
};

export interface PolarCheckoutReadiness {
  configured: boolean;
  enabled: boolean;
  usable: boolean;
  missingFields: PolarCheckoutRequiredField[];
  credentialErrors?: string[];
  blockedReason?: string;
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

export interface GatewaySettingsStoredRow {
  category: string;
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const STRIPE_CATEGORY = "stripe";
const STRIPE_CACHE_KEY = "gw:stripe";
const STRIPE_PLACEHOLDER_VALUES = new Set([
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
  "your_stripe_key",
  "your_stripe_webhook_secret_here",
  "sk_test_your_key_here",
  "pk_test_your_key_here",
  "whsec_your_webhook_secret",
]);

type StripeCredentialField = "secretKey" | "publishableKey" | "webhookSecret";

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function compactErrors(errors: Array<string | null | undefined>): string[] {
  return errors.filter((error): error is string => Boolean(error));
}

export function isStripePlaceholderCredential(value: unknown): boolean {
  return typeof value === "string" && STRIPE_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

export function getStripeCheckoutMissingFields(
  settings: Partial<Pick<StripeSettings, StripeCheckoutRequiredField>> | null | undefined,
): StripeCheckoutRequiredField[] {
  const missing: StripeCheckoutRequiredField[] = [];
  if (!hasText(settings?.secretKey)) missing.push("secretKey");
  if (!hasText(settings?.publishableKey)) missing.push("publishableKey");
  if (!hasText(settings?.webhookSecret)) missing.push("webhookSecret");
  return missing;
}

function stripeBlockedReason(missingFields: StripeCheckoutRequiredField[]): string | undefined {
  if (missingFields.length === 0) return undefined;
  const labels = missingFields.map((field) => STRIPE_CHECKOUT_FIELD_LABELS[field]);
  return `Stripe needs ${labels.join(", ")} before it can be shown at checkout.`;
}

function getStripePlaceholderCredentialErrors(
  settings: Partial<Pick<StripeSettings, StripeCredentialField>> | null | undefined,
): string[] {
  const errors: string[] = [];
  if (isStripePlaceholderCredential(settings?.secretKey)) {
    errors.push("Stripe secret key looks like a placeholder. Enter the real Stripe secret key from your merchant account.");
  }
  if (isStripePlaceholderCredential(settings?.publishableKey)) {
    errors.push("Stripe publishable key looks like a placeholder. Enter the real Stripe publishable key from your merchant account.");
  }
  if (isStripePlaceholderCredential(settings?.webhookSecret)) {
    errors.push("Stripe webhook secret looks like a placeholder. Enter the real Stripe webhook secret from your merchant account.");
  }
  return errors;
}

export function getStripeCheckoutReadiness(
  settings: Partial<StripeSettings> | null | undefined,
): StripeCheckoutReadiness {
  const missingFields = getStripeCheckoutMissingFields(settings);
  const environment = getStripeCredentialEnvironment(settings);
  const credentialErrors = compactErrors([
    ...(settings?.credentialErrors ?? []),
    ...getStripePlaceholderCredentialErrors(settings),
    environment === "mixed"
      ? "Stripe secret and publishable keys use different test/live environments. Choose a matching key pair."
      : null,
  ]);
  const enabled = settings?.enabled === true;
  const configured = missingFields.length === 0 && credentialErrors.length === 0;
  return {
    configured,
    enabled,
    usable: enabled && configured,
    missingFields,
    credentialErrors,
    blockedReason: credentialErrors[0] ?? stripeBlockedReason(missingFields),
  };
}

export function isStripeCheckoutUsable(
  settings: Partial<StripeSettings> | null | undefined,
): settings is StripeSettings {
  return getStripeCheckoutReadiness(settings).usable;
}

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
  const stripeSettings = await resolveStripeSettingsFromValues(values, encryptionKey);
  if (!stripeSettings) return null;

  // Cache in memory only — never persist decrypted credentials
  if (!options.bypassMemoryCache) {
    setCachedCredential(STRIPE_CACHE_KEY, stripeSettings);
  }

  return stripeSettings;
}

async function resolveStripeSettingsFromValues(
  values: Record<string, string>,
  encryptionKey?: string,
): Promise<StripeSettings | null> {
  if (!values.secret_key && !values.publishable_key && !values.webhook_secret && values.enabled === undefined) return null;

  const [secretKey, webhookSecret] = await Promise.all([
    readStoredCredentialStrict(values.secret_key, encryptionKey, "Stripe secret key"),
    readStoredCredentialStrict(values.webhook_secret, encryptionKey, "Stripe webhook secret"),
  ]);

  return {
    secretKey: secretKey.value,
    publishableKey: values.publishable_key ?? "",
    webhookSecret: webhookSecret.value,
    enabled: values.enabled !== "false",
    credentialErrors: compactErrors([secretKey.error, webhookSecret.error]),
  };
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
const SSLCOMMERZ_STORED_SECRET_MARKER = "__stored__";
const SSLCOMMERZ_PLACEHOLDER_VALUES = new Set([
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
  SSLCOMMERZ_STORED_SECRET_MARKER,
]);

type SSLCommerzCredentialField = "storeId" | "storePassword";

export function isSSLCommerzPlaceholderCredential(value: unknown): boolean {
  return typeof value === "string" && SSLCOMMERZ_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

export function getSSLCommerzCheckoutMissingFields(
  settings: Partial<Pick<SSLCommerzSettings, SSLCommerzCheckoutRequiredField>> | null | undefined,
): SSLCommerzCheckoutRequiredField[] {
  const missing: SSLCommerzCheckoutRequiredField[] = [];
  if (!hasText(settings?.storeId)) missing.push("storeId");
  if (!hasText(settings?.storePassword)) missing.push("storePassword");
  return missing;
}

function sslCommerzBlockedReason(missingFields: SSLCommerzCheckoutRequiredField[]): string | undefined {
  if (missingFields.length === 0) return undefined;
  const labels = missingFields.map((field) => SSLCOMMERZ_CHECKOUT_FIELD_LABELS[field]);
  return `SSLCommerz needs ${labels.join(", ")} before it can be shown at checkout.`;
}

function getSSLCommerzPlaceholderCredentialErrors(
  settings: Partial<Pick<SSLCommerzSettings, SSLCommerzCredentialField>> | null | undefined,
): string[] {
  const errors: string[] = [];
  if (isSSLCommerzPlaceholderCredential(settings?.storeId)) {
    errors.push("SSLCommerz store ID looks like a placeholder. Enter the real SSLCommerz store ID from your merchant account.");
  }
  if (isSSLCommerzPlaceholderCredential(settings?.storePassword)) {
    errors.push("SSLCommerz store password looks like a placeholder. Enter the real SSLCommerz store password from your merchant account.");
  }
  return errors;
}

export function getSSLCommerzCheckoutReadiness(
  settings: Partial<SSLCommerzSettings> | null | undefined,
): SSLCommerzCheckoutReadiness {
  const missingFields = getSSLCommerzCheckoutMissingFields(settings);
  const credentialErrors = compactErrors([
    ...(settings?.credentialErrors ?? []),
    ...getSSLCommerzPlaceholderCredentialErrors(settings),
  ]);
  const enabled = settings?.enabled === true;
  const configured = missingFields.length === 0 && credentialErrors.length === 0;
  return {
    configured,
    enabled,
    usable: enabled && configured,
    missingFields,
    credentialErrors,
    blockedReason: credentialErrors[0] ?? sslCommerzBlockedReason(missingFields),
  };
}

export function isSSLCommerzCheckoutUsable(
  settings: Partial<SSLCommerzSettings> | null | undefined,
): settings is SSLCommerzSettings {
  return getSSLCommerzCheckoutReadiness(settings).usable;
}

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
  const sslSettings = await resolveSSLCommerzSettingsFromValues(values, encryptionKey);
  if (!sslSettings) return null;

  // Cache in memory only — never persist decrypted credentials
  if (!options.bypassMemoryCache) {
    setCachedCredential(SSL_CACHE_KEY, sslSettings);
  }

  return sslSettings;
}

async function resolveSSLCommerzSettingsFromValues(
  values: Record<string, string>,
  encryptionKey?: string,
): Promise<SSLCommerzSettings | null> {
  if (!values.store_id && !values.store_password && values.sandbox === undefined && values.enabled === undefined) return null;

  const storePassword = await readStoredCredentialStrict(
    values.store_password,
    encryptionKey,
    "SSLCommerz store password",
  );

  return {
    storeId: values.store_id ?? "",
    storePassword: storePassword.value,
    sandbox: values.sandbox !== "false",
    enabled: values.enabled !== "false",
    credentialErrors: compactErrors([storePassword.error]),
  };
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
const POLAR_PLACEHOLDER_VALUES = new Set([
  "dummy",
  "placeholder",
  "example",
  "demo",
  "test",
  "polar_access_token",
  "polar_product_id",
  "polar_webhook_secret",
  "your_polar_token",
  "your_polar_access_token",
  "your_polar_product_id",
  "your_polar_webhook_secret",
  "your_polar_token_here",
  "your_polar_webhook_secret_here",
]);

type PolarCredentialField = "accessToken" | "productId" | "webhookSecret";

export function isPolarPlaceholderCredential(value: unknown): boolean {
  return typeof value === "string" && POLAR_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

export function getPolarCheckoutMissingFields(
  settings: Partial<Pick<PolarSettings, PolarCheckoutRequiredField>> | null | undefined,
): PolarCheckoutRequiredField[] {
  const missing: PolarCheckoutRequiredField[] = [];
  if (!hasText(settings?.accessToken)) missing.push("accessToken");
  if (!hasText(settings?.productId)) missing.push("productId");
  if (!hasText(settings?.webhookSecret)) missing.push("webhookSecret");
  return missing;
}

function polarBlockedReason(missingFields: PolarCheckoutRequiredField[]): string | undefined {
  if (missingFields.length === 0) return undefined;
  const labels = missingFields.map((field) => POLAR_CHECKOUT_FIELD_LABELS[field]);
  return `Polar needs ${labels.join(", ")} before it can be shown at checkout.`;
}

function getPolarPlaceholderCredentialErrors(
  settings: Partial<Pick<PolarSettings, PolarCredentialField>> | null | undefined,
): string[] {
  const errors: string[] = [];
  if (isPolarPlaceholderCredential(settings?.accessToken)) {
    errors.push("Polar access token looks like a placeholder. Enter the real Polar access token from your merchant account.");
  }
  if (isPolarPlaceholderCredential(settings?.productId)) {
    errors.push("Polar product ID looks like a placeholder. Enter the real Polar product ID from your merchant account.");
  }
  if (isPolarPlaceholderCredential(settings?.webhookSecret)) {
    errors.push("Polar webhook secret looks like a placeholder. Enter the real Polar webhook secret from your merchant account.");
  }
  return errors;
}

export function getPolarCheckoutReadiness(
  settings: Partial<PolarSettings> | null | undefined,
): PolarCheckoutReadiness {
  const missingFields = getPolarCheckoutMissingFields(settings);
  const credentialErrors = compactErrors([
    ...(settings?.credentialErrors ?? []),
    ...getPolarPlaceholderCredentialErrors(settings),
  ]);
  const enabled = settings?.enabled === true;
  const configured = missingFields.length === 0 && credentialErrors.length === 0;
  return {
    configured,
    enabled,
    usable: enabled && configured,
    missingFields,
    credentialErrors,
    blockedReason: credentialErrors[0] ?? polarBlockedReason(missingFields),
  };
}

export function isPolarCheckoutUsable(
  settings: Partial<PolarSettings> | null | undefined,
): settings is PolarSettings {
  return getPolarCheckoutReadiness(settings).usable;
}

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
  const polarSettings = await resolvePolarSettingsFromValues(values, encryptionKey);
  if (!polarSettings) return null;

  // Cache in memory only — never persist decrypted credentials
  if (!options.bypassMemoryCache) {
    setCachedCredential(POLAR_CACHE_KEY, polarSettings);
  }

  return polarSettings;
}

async function resolvePolarSettingsFromValues(
  values: Record<string, string>,
  encryptionKey?: string,
): Promise<PolarSettings | null> {
  if (!values.access_token && !values.product_id && !values.webhook_secret && values.sandbox === undefined && values.enabled === undefined) return null;

  const [accessToken, webhookSecret] = await Promise.all([
    readStoredCredentialStrict(values.access_token, encryptionKey, "Polar access token"),
    readStoredCredentialStrict(values.webhook_secret, encryptionKey, "Polar webhook secret"),
  ]);

  return {
    accessToken: accessToken.value,
    webhookSecret: webhookSecret.value,
    productId: values.product_id ?? "",
    sandbox: values.sandbox !== "false",
    enabled: values.enabled !== "false",
    credentialErrors: compactErrors([accessToken.error, webhookSecret.error]),
  };
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

/** Encrypt a provider secret then upsert it. New credential writes must fail closed when no key is configured. */
export async function upsertEncryptedSetting(
  db: Database,
  category: string,
  key: string,
  value: string,
  encryptionKey?: string,
): Promise<void> {
  if (!encryptionKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }

  const stored = encodeEncryptedCredential(await encryptCredentials(value, encryptionKey));
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

export interface PaymentMethodPreferences {
  /** Raw merchant-selected checkout allowlist before gateway readiness filtering. */
  enabledMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[];
  /** Raw merchant-selected default before gateway readiness filtering. */
  defaultMethod: "stripe" | "sslcommerz" | "polar" | "cod";
  /** Whether the allowlist was explicitly saved by the merchant. */
  hasExplicitEnabledMethods: boolean;
}

function parsePaymentMethodPreferences(
  values: Record<string, string>,
): PaymentMethodPreferences {
  let enabledMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[];
  const hasExplicitEnabledMethods = values.enabled_methods !== undefined;
  try {
    const parsed = values.enabled_methods
      ? JSON.parse(values.enabled_methods) as unknown
      : ["cod"];
    enabledMethods = Array.isArray(parsed)
      ? parsed.filter((method): method is ("stripe" | "sslcommerz" | "polar" | "cod") =>
          method === "stripe" ||
          method === "sslcommerz" ||
          method === "polar" ||
          method === "cod",
        )
      : [];
  } catch {
    enabledMethods = hasExplicitEnabledMethods ? [] : ["cod"];
  }

  const storedDefault = values.default_method;
  const defaultMethod = (
    storedDefault === "stripe" ||
    storedDefault === "sslcommerz" ||
    storedDefault === "polar" ||
    storedDefault === "cod"
  )
    ? storedDefault
    : "cod";

  return {
    enabledMethods,
    defaultMethod,
    hasExplicitEnabledMethods,
  };
}

export const STOREFRONT_GATEWAY_SETTING_CATEGORIES = [
  PAYMENT_METHODS_CATEGORY,
  STRIPE_CATEGORY,
  SSL_CATEGORY,
  POLAR_CATEGORY,
] as const;

export async function resolveActivePaymentMethodsFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey?: string,
): Promise<PaymentMethodsConfig> {
  const byCategory = new Map<string, Record<string, string>>();
  for (const row of rows) {
    const values = byCategory.get(row.category) ?? {};
    values[row.key] = row.value;
    byCategory.set(row.category, values);
  }

  const {
    enabledMethods,
    defaultMethod,
    hasExplicitEnabledMethods,
  } = parsePaymentMethodPreferences(byCategory.get(PAYMENT_METHODS_CATEGORY) ?? {});
  const validMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[] = [];

  for (const method of enabledMethods) {
    if (method === "cod") {
      validMethods.push(method);
      continue;
    }
    if (method === "stripe") {
      const stripe = await resolveStripeSettingsFromValues(
        byCategory.get(STRIPE_CATEGORY) ?? {},
        encryptionKey,
      );
      if (isStripeCheckoutUsable(stripe)) validMethods.push(method);
      continue;
    }
    if (method === "sslcommerz") {
      const sslcommerz = await resolveSSLCommerzSettingsFromValues(
        byCategory.get(SSL_CATEGORY) ?? {},
        encryptionKey,
      );
      if (isSSLCommerzCheckoutUsable(sslcommerz)) validMethods.push(method);
      continue;
    }
    const polar = await resolvePolarSettingsFromValues(
      byCategory.get(POLAR_CATEGORY) ?? {},
      encryptionKey,
    );
    if (isPolarCheckoutUsable(polar)) validMethods.push(method);
  }

  if (validMethods.length === 0 && !hasExplicitEnabledMethods) {
    validMethods.push("cod");
  }
  return {
    enabledMethods: validMethods,
    defaultMethod: validMethods.includes(defaultMethod)
      ? defaultMethod
      : (validMethods[0] ?? "cod"),
  };
}

export async function getPaymentMethodPreferences(
  db: Database,
): Promise<PaymentMethodPreferences> {
  return parsePaymentMethodPreferences(await readCategory(db, PAYMENT_METHODS_CATEGORY));
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

  const {
    enabledMethods,
    defaultMethod,
    hasExplicitEnabledMethods,
  } = await getPaymentMethodPreferences(db);

  // Cross-check: only include methods with valid credentials
  const validMethods: ("stripe" | "sslcommerz" | "polar" | "cod")[] = [];

  for (const method of enabledMethods) {
    if (method === "cod") {
      validMethods.push("cod");
      continue;
    }
    if (method === "stripe") {
      const stripe = await getStripeSettings(db, kv, encryptionKey, options);
      if (isStripeCheckoutUsable(stripe)) {
        validMethods.push("stripe");
      }
    }
    if (method === "sslcommerz") {
      const ssl = await getSSLCommerzSettings(db, kv, encryptionKey, options);
      if (isSSLCommerzCheckoutUsable(ssl)) {
        validMethods.push("sslcommerz");
      }
    }
    if (method === "polar") {
      const polar = await getPolarSettings(db, kv, encryptionKey, options);
      if (isPolarCheckoutUsable(polar)) {
        validMethods.push("polar");
      }
    }
  }

  // Legacy/default stores get COD, but explicit merchant allowlists fail closed
  // when no selected method is actually usable.
  if (validMethods.length === 0 && !hasExplicitEnabledMethods) {
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
    return isStripeCheckoutUsable(s) ? { ...s, enabled: true } : null;
  },
  getPublicConfig: (s) => ({
    publishableKey: typeof s.publishableKey === "string" ? s.publishableKey.trim() : "",
    testMode: getStripeCredentialEnvironment(s) === "test",
  }),
  getCurrencies: (localCurrency) => [localCurrency, "usd", "eur", "gbp"],
});

registerGateway({
  id: "sslcommerz",
  name: "Online Payment",
  settingsCategory: SSL_CATEGORY,
  getSettings: async (db, kv, encryptionKey, options) => {
    const s = await getSSLCommerzSettings(db, kv, encryptionKey, options);
    return isSSLCommerzCheckoutUsable(s) ? { ...s, enabled: true } : null;
  },
  getPublicConfig: (s) => ({
    sandbox: s.sandbox,
    testMode: s.sandbox === true,
  }),
  getCurrencies: (localCurrency) => [localCurrency],
});

registerGateway({
  id: "polar",
  name: "Polar",
  settingsCategory: POLAR_CATEGORY,
  getSettings: async (db, kv, encryptionKey, options) => {
    const s = await getPolarSettings(db, kv, encryptionKey, options);
    return isPolarCheckoutUsable(s) ? { ...s, enabled: true } : null;
  },
  getPublicConfig: (s) => ({
    sandbox: s.sandbox,
    testMode: s.sandbox === true,
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
