// src/modules/payments/gateway-settings.ts
// Reads payment gateway configuration from the authoritative settings
// documents (`stripe`, `sslcommerz`, `payment_methods`). Request paths may
// load one relational snapshot, but decrypted credentials are never retained
// in Worker-global memory or written to KV.

import type { Database } from "@scalius/database/client";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import {
  paymentMethodsDocument,
  sslcommerzDocument,
  stripeDocument,
} from "../settings/documents";
import {
  selectSettingsDocuments,
  type SettingsDocumentRow,
} from "../settings/settings-store";

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

/** A stored gateway settings document row (see `selectSettingsDocuments`). */
export type GatewaySettingsStoredRow = SettingsDocumentRow;

async function readGatewayRows(db: Database): Promise<GatewaySettingsStoredRow[]> {
  return selectSettingsDocuments(db, [paymentMethodsDocument, stripeDocument, sslcommerzDocument]);
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

const STRIPE_CATEGORY = stripeDocument.key;
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

/** "Add the publishable key and webhook secret to turn on Stripe." */
function missingFieldsReason(gateway: string, labels: string[]): string | undefined {
  if (labels.length === 0) return undefined;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `Add the ${list} to turn on ${gateway}.`;
}

function stripeBlockedReason(missingFields: StripeCheckoutRequiredField[]): string | undefined {
  return missingFieldsReason("Stripe", missingFields.map((field) => STRIPE_CHECKOUT_FIELD_LABELS[field]));
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
  encryptionKey?: string,
): Promise<StripeSettings | null> {
  return resolveStripeSettingsFromRows(await readGatewayRows(db), encryptionKey);
}

async function resolveStripeSettingsFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey?: string,
): Promise<StripeSettings | null> {
  const stored = await stripeDocument.fromRows(rows, { encryptionKey });
  if (!stored.stored) return null;
  return {
    ...stored.value,
    credentialErrors: compactErrors([stored.secretErrors.secretKey, stored.secretErrors.webhookSecret]),
  };
}

// ---------------------------------------------------------------------------
// SSLCommerz
// ---------------------------------------------------------------------------

const SSL_CATEGORY = sslcommerzDocument.key;
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
  return missingFieldsReason("SSLCommerz", missingFields.map((field) => SSLCOMMERZ_CHECKOUT_FIELD_LABELS[field]));
}

function getSSLCommerzPlaceholderCredentialErrors(
  settings: Partial<Pick<SSLCommerzSettings, SSLCommerzCredentialField | "sandbox">> | null | undefined,
): string[] {
  const officialSandboxAccount = settings?.sandbox === true &&
    settings.storeId?.trim() === "testbox" &&
    settings.storePassword?.trim() === "qwerty";
  if (officialSandboxAccount) return [];

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
  encryptionKey?: string,
): Promise<SSLCommerzSettings | null> {
  return resolveSSLCommerzSettingsFromRows(await readGatewayRows(db), encryptionKey);
}

async function resolveSSLCommerzSettingsFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey?: string,
): Promise<SSLCommerzSettings | null> {
  const stored = await sslcommerzDocument.fromRows(rows, { encryptionKey });
  if (!stored.stored) return null;
  return {
    ...stored.value,
    credentialErrors: compactErrors([stored.secretErrors.storePassword]),
  };
}

// ---------------------------------------------------------------------------
// Payment Methods Configuration (storefront-facing)
// ---------------------------------------------------------------------------

const PAYMENT_METHODS_CATEGORY = paymentMethodsDocument.key;

export interface PaymentMethodsConfig {
  /** Which payment methods are enabled for the storefront */
  enabledMethods: ("stripe" | "sslcommerz" | "cod")[];
  /** Default payment method shown first on checkout */
  defaultMethod: "stripe" | "sslcommerz" | "cod";
}

export interface PaymentMethodPreferences {
  /** Raw merchant-selected checkout allowlist before gateway readiness filtering. */
  enabledMethods: ("stripe" | "sslcommerz" | "cod")[];
  /** Raw merchant-selected default before gateway readiness filtering. */
  defaultMethod: "stripe" | "sslcommerz" | "cod";
  /** Whether the allowlist was explicitly saved by the merchant. */
  hasExplicitEnabledMethods: boolean;
}

type PaymentMethodId = PaymentMethodsConfig["defaultMethod"];

function isPaymentMethodId(method: unknown): method is PaymentMethodId {
  return method === "stripe" || method === "sslcommerz" || method === "cod";
}

/**
 * Without a saved allowlist, COD is the implied checkout method. A saved but
 * unreadable allowlist enables nothing: checkout never guesses COD.
 */
async function resolvePaymentMethodPreferences(
  rows: readonly GatewaySettingsStoredRow[],
): Promise<PaymentMethodPreferences> {
  const read = await paymentMethodsDocument.fromRows(rows);
  if (read.invalid) return { enabledMethods: [], defaultMethod: "cod", hasExplicitEnabledMethods: true };
  const { enabledMethods, defaultMethod } = read.value;
  return {
    enabledMethods: enabledMethods === null
      ? ["cod"]
      : Array.from(new Set(enabledMethods.filter(isPaymentMethodId))),
    defaultMethod: isPaymentMethodId(defaultMethod) ? defaultMethod : "cod",
    hasExplicitEnabledMethods: enabledMethods !== null,
  };
}

export const STOREFRONT_GATEWAY_SETTING_CATEGORIES = [
  PAYMENT_METHODS_CATEGORY,
  STRIPE_CATEGORY,
  SSL_CATEGORY,
] as const;

export interface PaymentGatewaySettingsSnapshot {
  preferences: PaymentMethodPreferences;
  activePaymentMethods: PaymentMethodsConfig;
  settings: {
    stripe: StripeSettings | null;
    sslcommerz: SSLCommerzSettings | null;
    cod: { enabled: true };
  };
}

type ResolvedGatewaySettings = PaymentGatewaySettingsSnapshot["settings"];

function buildActivePaymentMethods(
  preferences: PaymentMethodPreferences,
  resolved: ResolvedGatewaySettings,
): PaymentMethodsConfig {
  const validMethods: ("stripe" | "sslcommerz" | "cod")[] = [];
  for (const method of preferences.enabledMethods) {
    if (method === "cod") validMethods.push(method);
    else if (method === "stripe" && isStripeCheckoutUsable(resolved.stripe)) validMethods.push(method);
    else if (method === "sslcommerz" && isSSLCommerzCheckoutUsable(resolved.sslcommerz)) validMethods.push(method);
  }
  if (validMethods.length === 0 && !preferences.hasExplicitEnabledMethods) {
    validMethods.push("cod");
  }
  return {
    enabledMethods: validMethods,
    defaultMethod: validMethods.includes(preferences.defaultMethod)
      ? preferences.defaultMethod
      : (validMethods[0] ?? "cod"),
  };
}

async function resolvePaymentGatewaySettingsSnapshotFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey?: string,
): Promise<PaymentGatewaySettingsSnapshot> {
  const [preferences, stripe, sslcommerz] = await Promise.all([
    resolvePaymentMethodPreferences(rows),
    resolveStripeSettingsFromRows(rows, encryptionKey),
    resolveSSLCommerzSettingsFromRows(rows, encryptionKey),
  ]);
  const resolved = { stripe, sslcommerz, cod: { enabled: true as const } };
  return {
    preferences,
    activePaymentMethods: buildActivePaymentMethods(preferences, resolved),
    settings: resolved,
  };
}

export async function resolveActivePaymentMethodsFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey?: string,
): Promise<PaymentMethodsConfig> {
  const preferences = await resolvePaymentMethodPreferences(rows);
  const enabled = new Set(preferences.enabledMethods);
  const [stripe, sslcommerz] = await Promise.all([
    enabled.has("stripe") ? resolveStripeSettingsFromRows(rows, encryptionKey) : null,
    enabled.has("sslcommerz") ? resolveSSLCommerzSettingsFromRows(rows, encryptionKey) : null,
  ]);
  return buildActivePaymentMethods(preferences, {
    stripe,
    sslcommerz,
    cod: { enabled: true },
  });
}

export async function getPaymentGatewaySettingsSnapshot(
  db: Database,
  encryptionKey?: string,
): Promise<PaymentGatewaySettingsSnapshot> {
  return resolvePaymentGatewaySettingsSnapshotFromRows(await readGatewayRows(db), encryptionKey);
}

export async function getPaymentMethodPreferences(
  db: Database,
): Promise<PaymentMethodPreferences> {
  return resolvePaymentMethodPreferences(await readGatewayRows(db));
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
  encryptionKey?: string,
): Promise<PaymentMethodsConfig> {
  return resolveActivePaymentMethodsFromRows(await readGatewayRows(db), encryptionKey);
}
