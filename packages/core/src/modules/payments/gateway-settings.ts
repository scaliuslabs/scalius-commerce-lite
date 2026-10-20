// src/modules/payments/gateway-settings.ts
// Reads payment gateway configuration from the authoritative settings
// documents (`stripe`, `payment_methods`); app gateways read their own. Request paths may
// load one relational snapshot, but decrypted credentials are never retained
// in Worker-global memory or written to KV.

import type { Database } from "@scalius/database/client";
import { getStripeCredentialEnvironment } from "@scalius/shared/payment-gateway-environment";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { isPaymentMethodId, NET_TERMS_PAYMENT_METHOD } from "./gateways/identity";
import { DEFAULT_NET_TERMS_SETTINGS, type NetTermsSettings } from "@scalius/shared/payment-terms";
import type { PaymentGateway } from "./gateways/port";
import type { PaymentProviders, PaymentProvidersSource } from "./gateways/registry";
import { paymentMethodsDocument, stripeDocument } from "../settings";
import {
  selectSettingsDocuments,
  type SettingsDocumentRow,
} from "../../settings-store";

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

/** A stored gateway settings document row (see `selectSettingsDocuments`). */
export type GatewaySettingsStoredRow = SettingsDocumentRow;

async function readGatewayRows(db: Database): Promise<GatewaySettingsStoredRow[]> {
  return selectSettingsDocuments(db, [paymentMethodsDocument, stripeDocument]);
}
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
export interface PaymentMethodsConfig {
  /** Which payment methods are enabled for the storefront: `cod`, `net_terms`, built-in gateways, app providers. */
  enabledMethods: string[];
  /** Default payment method shown first on checkout */
  defaultMethod: string;
  /** The built-in invoice's days and eligibility (`net_terms`; used only when it is enabled). */
  netTerms: NetTermsSettings;
}

export interface PaymentMethodPreferences {
  /** Raw merchant-selected checkout allowlist before gateway readiness filtering. */
  enabledMethods: string[];
  /** Raw merchant-selected default before gateway readiness filtering. */
  defaultMethod: string;
  /** Whether the allowlist was explicitly saved by the merchant. */
  hasExplicitEnabledMethods: boolean;
  /** The built-in invoice's saved days and eligibility. */
  netTerms: NetTermsSettings;
}

/**
 * Whether each app payment provider (`<plugin id>:<provider id>`) can take a
 * payment now: its settings loaded strictly and its readiness checked
 * (`resolveAppPaymentUsability`). An app method missing here is not usable.
 */
export type AppPaymentUsability = ReadonlyMap<string, boolean>;

const NO_APP_PAYMENTS: AppPaymentUsability = new Map();

/**
 * Without a saved allowlist, COD is the implied checkout method. A saved but
 * unreadable allowlist enables nothing: checkout never guesses COD.
 */
async function resolvePaymentMethodPreferences(
  rows: readonly GatewaySettingsStoredRow[],
): Promise<PaymentMethodPreferences> {
  const read = await paymentMethodsDocument.fromRows(rows);
  if (read.invalid) {
    return { enabledMethods: [], defaultMethod: "cod", hasExplicitEnabledMethods: true, netTerms: { ...DEFAULT_NET_TERMS_SETTINGS } };
  }
  const { enabledMethods, defaultMethod, netTerms } = read.value;
  return {
    enabledMethods: enabledMethods === null
      ? ["cod"]
      : Array.from(new Set(enabledMethods.filter(isPaymentMethodId))),
    defaultMethod: isPaymentMethodId(defaultMethod) ? defaultMethod : "cod",
    hasExplicitEnabledMethods: enabledMethods !== null,
    netTerms,
  };
}

export interface PaymentGatewaySettingsSnapshot {
  preferences: PaymentMethodPreferences;
  activePaymentMethods: PaymentMethodsConfig;
  /** The providers asked for the enabled app methods; absent when none is enabled. */
  providers?: PaymentProviders;
  settings: {
    stripe: StripeSettings | null;
    cod: { enabled: true };
  };
}

type ResolvedGatewaySettings = PaymentGatewaySettingsSnapshot["settings"];

function buildActivePaymentMethods(
  preferences: PaymentMethodPreferences,
  resolved: ResolvedGatewaySettings,
  apps: AppPaymentUsability,
): PaymentMethodsConfig {
  const validMethods: string[] = [];
  for (const method of preferences.enabledMethods) {
    // Cash on delivery and the invoice need no credentials; the invoice
    // reaches a buyer only through its eligibility (checkout/payment-terms.ts).
    if (method === "cod" || method === NET_TERMS_PAYMENT_METHOD) validMethods.push(method);
    else if (method === "stripe") {
      if (isStripeCheckoutUsable(resolved.stripe)) validMethods.push(method);
    } else if (apps.get(method) === true) validMethods.push(method);
  }
  if (validMethods.length === 0 && !preferences.hasExplicitEnabledMethods) {
    validMethods.push("cod");
  }
  return {
    enabledMethods: validMethods,
    defaultMethod: validMethods.includes(preferences.defaultMethod)
      ? preferences.defaultMethod
      : (validMethods[0] ?? "cod"),
    netTerms: preferences.netTerms,
  };
}

async function resolvePaymentGatewaySettingsSnapshotFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey: string | undefined,
  apps: AppPaymentUsability,
): Promise<PaymentGatewaySettingsSnapshot> {
  const [preferences, stripe] = await Promise.all([
    resolvePaymentMethodPreferences(rows),
    resolveStripeSettingsFromRows(rows, encryptionKey),
  ]);
  const resolved = { stripe, cod: { enabled: true as const } };
  return {
    preferences,
    activePaymentMethods: buildActivePaymentMethods(preferences, resolved, apps),
    settings: resolved,
  };
}

export async function resolveActivePaymentMethodsFromRows(
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey?: string,
  apps: AppPaymentUsability = NO_APP_PAYMENTS,
): Promise<PaymentMethodsConfig> {
  const preferences = await resolvePaymentMethodPreferences(rows);
  const enabled = new Set(preferences.enabledMethods);
  const stripe = enabled.has("stripe") ? await resolveStripeSettingsFromRows(rows, encryptionKey) : null;
  return buildActivePaymentMethods(preferences, { stripe, cod: { enabled: true } }, apps);
}

/**
 * Usability of the app methods the merchant enabled. `providers` is asked
 * only when one is enabled, so a store whose methods are all built in reads
 * no plugin table; without it app methods are not usable.
 */
async function enabledAppPayments(
  db: Database,
  rows: readonly GatewaySettingsStoredRow[],
  encryptionKey: string | undefined,
  source: PaymentProvidersSource | undefined,
): Promise<{ apps: AppPaymentUsability; providers?: PaymentProviders }> {
  const appIds = (await resolvePaymentMethodPreferences(rows)).enabledMethods.filter(isQualifiedProviderId);
  if (appIds.length === 0 || !source) return { apps: NO_APP_PAYMENTS };
  const providers = typeof source === "function" ? await source() : source;
  const enabled = providers.gateways.filter((gateway) => appIds.includes(gateway.id));
  return { apps: await resolveAppPaymentUsability(db, enabled, encryptionKey), providers };
}

export async function getPaymentGatewaySettingsSnapshot(
  db: Database,
  encryptionKey?: string,
  /** The request's gateways, for enabled app methods (see `enabledAppPayments`). */
  providers?: PaymentProvidersSource,
): Promise<PaymentGatewaySettingsSnapshot> {
  const rows = await readGatewayRows(db);
  const app = await enabledAppPayments(db, rows, encryptionKey, providers);
  const snapshot = await resolvePaymentGatewaySettingsSnapshotFromRows(rows, encryptionKey, app.apps);
  return app.providers ? { ...snapshot, providers: app.providers } : snapshot;
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
 * if it's both enabled AND has credentials (COD always works). App payment
 * methods count only when their provider is among `providers` and ready.
 */
export async function getActivePaymentMethods(
  db: Database,
  encryptionKey?: string,
  /** The request's gateways, for enabled app methods (see `enabledAppPayments`). */
  providers?: PaymentProvidersSource,
): Promise<PaymentMethodsConfig> {
  const rows = await readGatewayRows(db);
  const { apps } = await enabledAppPayments(db, rows, encryptionKey, providers);
  return resolveActivePaymentMethodsFromRows(rows, encryptionKey, apps);
}

/**
 * Loads each app gateway's settings strictly and checks its readiness, in
 * parallel: the usability map the functions above take.
 */
export async function resolveAppPaymentUsability(
  db: Database,
  gateways: readonly PaymentGateway[],
  encryptionKey?: string,
): Promise<AppPaymentUsability> {
  const apps = gateways.filter((gateway) => isQualifiedProviderId(gateway.id));
  const usable = await Promise.all(apps.map(async (gateway) => {
    try {
      return gateway.readiness(await gateway.loadSettings(db, encryptionKey)).usable;
    } catch {
      return false;
    }
  }));
  return new Map(apps.map((gateway, index) => [gateway.id, usable[index]!]));
}
