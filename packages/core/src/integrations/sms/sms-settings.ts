// src/integrations/sms/sms-settings.ts
// SMS provider settings (the `sms` settings document).
//
// SECURITY: Decrypted credentials are NEVER written to KV or any persistent
// store. Dispatch reads the authoritative document for every send so a
// credential rotation cannot leave another warm Worker isolate using an old
// provider instance.

import {
  readiness,
  readinessIssue,
  type Readiness,
} from "@scalius/shared/readiness";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import {
  smsDocument,
  type SmsSettings,
} from "../../modules/settings/documents";
import type { SettingsDocumentReadResult } from "../../modules/settings/settings-store";
import { SMS_PROVIDER_IDS, type SmsProvider, type SmsProviderId } from "./provider";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MASKED = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"; // 12 bullet chars
const PLACEHOLDER_EXACT_VALUES = new Set([
  "000000",
  "111111",
  "123456",
  "123456789",
  "apikey",
  "apitoken",
  "changeme",
  "changeit",
  "demo",
  "dummy",
  "example",
  "password",
  "sample",
  "secret",
  "test",
  "testing",
  "token",
  "yourapikey",
  "yourapikeyhere",
  "yourapi",
  "yourtoken",
  "yourtokenhere",
]);

const PLACEHOLDER_WORD_VALUES = new Set([
  "changeme",
  "dummy",
  "example",
  "placeholder",
  "sample",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsSettingsData {
  activeProvider: SmsProviderId | null;
  activeProviderConfigured: boolean;
  activeProviderError: string | null;
  // Per-provider fields (all returned, UI shows conditionally)
  bdbulksmsToken: string; // masked on GET
  mimsmsUsername: string;
  mimsmsApiKey: string; // masked on GET
  mimsmsSenderName: string;
  smsnetbdApiKey: string; // masked on GET
  smsnetbdSenderId: string;
  gennetApiToken: string; // masked on GET
  gennetBaseUrl: string;
  gennetSid: string;
  /** The SMS document revision a save must send back as `expectedRevision`. */
  revision: number;
}

/** Stable issue code for SMS provider setup. */
export const SMS_READINESS_CODE = "missing_sms_provider_credentials";

/**
 * The shared readiness vocabulary plus the typed extra callers need: which
 * provider the merchant selected.
 */
export interface SmsProviderReadiness extends Readiness {
  activeProvider: SmsProviderId | null;
}

type StoredSms = SettingsDocumentReadResult<SmsSettings>;

async function readSms(db: Database, encryptionKey?: string): Promise<StoredSms> {
  return smsDocument.readDetailed(db, { encryptionKey });
}

async function instantiateSmsProvider(
  stored: StoredSms,
): Promise<{
  activeProvider: SmsProviderId | null;
  provider: SmsProvider | null;
  error: string | null;
}> {
  const vals = stored.value;
  const secretError = (field: keyof SmsSettings) => stored.secretErrors[field] ?? null;
  const providerName = (vals.activeProvider || undefined) as SmsProviderId | undefined;
  if (!providerName) {
    return {
      activeProvider: null,
      provider: null,
      error: "No active SMS provider selected",
    };
  }

  let provider: SmsProvider;

  switch (providerName) {
    case "smsnetbd": {
      const { SmsNetBdProvider } = await import("./providers/smsnetbd");
      const error = secretError("smsnetbdApiKey");
      if (error) return smsProviderReadinessError(providerName, error);
      const placeholderError = firstPlaceholderConfigError([
        ["SMS.net.bd API key", vals.smsnetbdApiKey],
        ["SMS.net.bd sender ID", vals.smsnetbdSenderId],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new SmsNetBdProvider({
        apiKey: vals.smsnetbdApiKey,
        senderId: vals.smsnetbdSenderId || undefined,
      });
      break;
    }
    case "bdbulksms": {
      const { BdBulkSmsProvider } = await import("./providers/bdbulksms");
      const error = secretError("bdbulksmsToken");
      if (error) return smsProviderReadinessError(providerName, error);
      const placeholderError = firstPlaceholderConfigError([
        ["BDBulkSMS token", vals.bdbulksmsToken],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new BdBulkSmsProvider({
        token: vals.bdbulksmsToken,
      });
      break;
    }
    case "mimsms": {
      const { MimSmsProvider } = await import("./providers/mimsms");
      const error = secretError("mimsmsApiKey");
      if (error) return smsProviderReadinessError(providerName, error);
      const placeholderError = firstPlaceholderConfigError([
        ["MIM SMS username", vals.mimsmsUsername],
        ["MIM SMS API key", vals.mimsmsApiKey],
        ["MIM SMS sender name", vals.mimsmsSenderName],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new MimSmsProvider({
        userName: vals.mimsmsUsername,
        apiKey: vals.mimsmsApiKey,
        senderName: vals.mimsmsSenderName,
      });
      break;
    }
    case "gennet": {
      const { GennetProvider } = await import("./providers/gennet");
      const error = secretError("gennetApiToken");
      if (error) return smsProviderReadinessError(providerName, error);
      const placeholderError = firstPlaceholderConfigError([
        ["GenNet API token", vals.gennetApiToken],
        ["GenNet base URL", vals.gennetBaseUrl],
        ["GenNet SID", vals.gennetSid],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new GennetProvider({
        apiToken: vals.gennetApiToken,
        baseUrl: vals.gennetBaseUrl,
        sid: vals.gennetSid,
      });
      break;
    }
    default:
      return {
        activeProvider: null,
        provider: null,
        error: `Unsupported SMS provider "${providerName}"`,
      };
  }

  const validationError = provider.validateConfig();
  return {
    activeProvider: providerName,
    provider: validationError ? null : provider,
    error: validationError,
  };
}

function firstPlaceholderConfigError(
  fields: Array<[label: string, value: string | null | undefined]>,
): string | null {
  for (const [label, value] of fields) {
    if (looksLikePlaceholderCredential(value)) {
      return `${label} looks like a placeholder. Save a real provider value before enabling SMS.`;
    }
  }
  return null;
}

function looksLikePlaceholderCredential(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === MASKED) return false;

  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) return false;
  if (PLACEHOLDER_EXACT_VALUES.has(normalized)) return true;
  if (/^([0-9])\1{3,}$/.test(normalized)) return true;
  if (/^1234567890?$/.test(normalized)) return true;

  const words = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((word) => PLACEHOLDER_WORD_VALUES.has(word))) return true;
  if (words.length <= 2 && words.some((word) => word === "test" || word === "demo")) {
    return true;
  }
  if (words[0] === "your" && words.some((word) => word === "key" || word === "token" || word === "api")) {
    return true;
  }

  return false;
}

function smsProviderReadinessError(
  activeProvider: SmsProviderId,
  error: string,
): {
  activeProvider: SmsProviderId;
  provider: null;
  error: string;
} {
  return {
    activeProvider,
    provider: null,
    error,
  };
}

export async function getSmsProviderReadiness(
  db: Database,
  encryptionKey?: string,
): Promise<SmsProviderReadiness> {
  const resolved = await instantiateSmsProvider(await readSms(db, encryptionKey));
  const configured = Boolean(resolved.provider);
  const value = configured
    ? readiness.ready()
    : readiness.incomplete([readinessIssue(
        SMS_READINESS_CODE,
        resolved.error
          ?? "Configure an SMS provider before sending SMS messages.",
      )]);

  return { ...value, activeProvider: resolved.activeProvider };
}

// ---------------------------------------------------------------------------
// Read settings (masked secrets)
// ---------------------------------------------------------------------------

/**
 * Read all SMS settings from DB.
 * Encrypted fields are returned as MASKED when configured, empty string when not.
 */
export async function getSmsSettings(
  db: Database,
  encryptionKey?: string,
): Promise<SmsSettingsData> {
  const stored = await readSms(db, encryptionKey);
  const readiness = await instantiateSmsProvider(stored);
  const vals = stored.value;
  // A secret is "stored" even when this request cannot decrypt it.
  const masked = (field: keyof SmsSettings) =>
    vals[field] || stored.secretErrors[field] ? MASKED : "";

  return {
    activeProvider: (vals.activeProvider || null) as SmsProviderId | null,
    activeProviderConfigured: Boolean(readiness.provider),
    activeProviderError: readiness.error,
    bdbulksmsToken: masked("bdbulksmsToken"),
    mimsmsUsername: vals.mimsmsUsername,
    mimsmsApiKey: masked("mimsmsApiKey"),
    mimsmsSenderName: vals.mimsmsSenderName,
    smsnetbdApiKey: masked("smsnetbdApiKey"),
    smsnetbdSenderId: vals.smsnetbdSenderId,
    gennetApiToken: masked("gennetApiToken"),
    gennetBaseUrl: vals.gennetBaseUrl,
    gennetSid: vals.gennetSid,
    revision: stored.revision,
  };
}

// ---------------------------------------------------------------------------
// Save settings (skip masked = unchanged)
// ---------------------------------------------------------------------------

/**
 * Save SMS settings. Only writes fields that are provided and not masked.
 */
export async function saveSmsSettings(
  db: Database,
  data: Partial<{
    activeProvider: string;
    bdbulksmsToken: string;
    mimsmsUsername: string;
    mimsmsApiKey: string;
    mimsmsSenderName: string;
    smsnetbdApiKey: string;
    smsnetbdSenderId: string;
    gennetApiToken: string;
    gennetBaseUrl: string;
    gennetSid: string;
  }>,
  encryptionKey?: string,
  /** The revision the editor loaded; a stale one is a 409 conflict. */
  options: { expectedRevision?: number } = {},
): Promise<{ revision: number }> {
  validateSmsSettingsInput(data);
  // A masked or empty secret means "unchanged"; secrets are never cleared here.
  const patch: Partial<SmsSettings> = {};
  for (const [field, value] of Object.entries(data) as Array<[keyof SmsSettings, string | undefined]>) {
    if (value === undefined) continue;
    if (SMS_SECRET_FIELDS.has(field) && (!value || value === MASKED)) continue;
    patch[field] = value;
  }
  const { revision } = await smsDocument.write(db, patch, { encryptionKey }, options);
  return { revision };
}

const SMS_SECRET_FIELDS = new Set<keyof SmsSettings>([
  "bdbulksmsToken",
  "mimsmsApiKey",
  "smsnetbdApiKey",
  "gennetApiToken",
]);

function validateSmsSettingsInput(
  data: Partial<{
    activeProvider: string;
    bdbulksmsToken: string;
    mimsmsUsername: string;
    mimsmsApiKey: string;
    mimsmsSenderName: string;
    smsnetbdApiKey: string;
    smsnetbdSenderId: string;
    gennetApiToken: string;
    gennetBaseUrl: string;
    gennetSid: string;
  }>,
): void {
  if (
    data.activeProvider
    && !SMS_PROVIDER_IDS.includes(data.activeProvider as SmsProviderId)
  ) {
    throw new ValidationError("Unsupported SMS provider.");
  }
  const placeholderError = firstPlaceholderConfigError([
    ["BDBulkSMS token", data.bdbulksmsToken],
    ["MIM SMS username", data.mimsmsUsername],
    ["MIM SMS API key", data.mimsmsApiKey],
    ["MIM SMS sender name", data.mimsmsSenderName],
    ["SMS.net.bd API key", data.smsnetbdApiKey],
    ["SMS.net.bd sender ID", data.smsnetbdSenderId],
    ["GenNet API token", data.gennetApiToken],
    ["GenNet base URL", data.gennetBaseUrl],
    ["GenNet SID", data.gennetSid],
  ]);
  if (placeholderError) throw new ValidationError(placeholderError);
}

// ---------------------------------------------------------------------------
// Active provider resolver (used by queue consumer at dispatch time)
// ---------------------------------------------------------------------------

/**
 * Resolve the active SMS provider by reading settings from DB, decrypting
 * credentials, and instantiating the provider.
 *
 * This is called by the queue consumer at dispatch time.
 * Returns null (does not throw) when no provider is configured.
 */
export async function getActiveSmsProvider(
  db: Database,
  encryptionKey?: string,
): Promise<SmsProvider | null> {
  const resolved = await instantiateSmsProvider(await readSms(db, encryptionKey));

  if (resolved.error) {
    console.error(
      `[SMS] Provider "${resolved.activeProvider ?? "none"}" is not ready: ${resolved.error}`,
    );
    return null;
  }

  return resolved.provider;
}
