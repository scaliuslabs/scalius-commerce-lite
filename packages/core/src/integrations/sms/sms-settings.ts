// src/integrations/sms/sms-settings.ts
// SMS settings service for reading/writing encrypted credentials from/to
// the `settings` table (category "sms"). Follows gateway-settings.ts pattern.
//
// SECURITY: Decrypted credentials are NEVER written to KV or any persistent
// store. Dispatch reads the authoritative settings row for every send so a
// credential rotation cannot leave another warm Worker isolate using an old
// provider instance.

import { eq, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { settings } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  encodeEncryptedCredential,
  encryptCredentials,
  readStoredCredentialStrict,
} from "@scalius/core/utils/credential-encryption";
import { ValidationError } from "@scalius/core/errors";
import { SMS_PROVIDER_IDS, type SmsProvider, type SmsProviderId } from "./provider";

type SQLiteBatchItem = BatchItem<"sqlite">;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SMS_CATEGORY = "sms";
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
}

export interface SmsProviderReadiness {
  activeProvider: SmsProviderId | null;
  configured: boolean;
  error: string | null;
}

type SmsSettingValues = Record<string, string>;

interface ResolvedSmsSecret {
  value: string;
  error: string | null;
}

async function readSmsSettingValues(db: Database): Promise<SmsSettingValues> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, SMS_CATEGORY))
    .all();

  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function instantiateSmsProvider(
  vals: SmsSettingValues,
  encryptionKey?: string,
): Promise<{
  activeProvider: SmsProviderId | null;
  provider: SmsProvider | null;
  error: string | null;
}> {
  const providerName = vals.active_provider as SmsProviderId | undefined;
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
      const apiKey = await resolveSmsSecret(
        vals.smsnetbd_api_key ?? "",
        encryptionKey,
        "SMS.net.bd API key",
      );
      if (apiKey.error) return smsProviderReadinessError(providerName, apiKey.error);
      const placeholderError = firstPlaceholderConfigError([
        ["SMS.net.bd API key", apiKey.value],
        ["SMS.net.bd sender ID", vals.smsnetbd_sender_id],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new SmsNetBdProvider({
        apiKey: apiKey.value,
        senderId: vals.smsnetbd_sender_id || undefined,
      });
      break;
    }
    case "bdbulksms": {
      const { BdBulkSmsProvider } = await import("./providers/bdbulksms");
      const token = await resolveSmsSecret(
        vals.bdbulksms_token ?? "",
        encryptionKey,
        "BDBulkSMS token",
      );
      if (token.error) return smsProviderReadinessError(providerName, token.error);
      const placeholderError = firstPlaceholderConfigError([
        ["BDBulkSMS token", token.value],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new BdBulkSmsProvider({
        token: token.value,
      });
      break;
    }
    case "mimsms": {
      const { MimSmsProvider } = await import("./providers/mimsms");
      const apiKey = await resolveSmsSecret(
        vals.mimsms_api_key ?? "",
        encryptionKey,
        "MIM SMS API key",
      );
      if (apiKey.error) return smsProviderReadinessError(providerName, apiKey.error);
      const placeholderError = firstPlaceholderConfigError([
        ["MIM SMS username", vals.mimsms_username],
        ["MIM SMS API key", apiKey.value],
        ["MIM SMS sender name", vals.mimsms_sender_name],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new MimSmsProvider({
        userName: vals.mimsms_username ?? "",
        apiKey: apiKey.value,
        senderName: vals.mimsms_sender_name ?? "",
      });
      break;
    }
    case "gennet": {
      const { GennetProvider } = await import("./providers/gennet");
      const apiToken = await resolveSmsSecret(
        vals.gennet_api_token ?? "",
        encryptionKey,
        "GenNet API token",
      );
      if (apiToken.error) return smsProviderReadinessError(providerName, apiToken.error);
      const placeholderError = firstPlaceholderConfigError([
        ["GenNet API token", apiToken.value],
        ["GenNet base URL", vals.gennet_base_url],
        ["GenNet SID", vals.gennet_sid],
      ]);
      if (placeholderError) return smsProviderReadinessError(providerName, placeholderError);
      provider = new GennetProvider({
        apiToken: apiToken.value,
        baseUrl: vals.gennet_base_url ?? "",
        sid: vals.gennet_sid ?? "",
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

async function resolveSmsSecret(
  storedValue: string,
  encryptionKey: string | undefined,
  label: string,
): Promise<ResolvedSmsSecret> {
  const result = await readStoredCredentialStrict(storedValue, encryptionKey, label);
  return {
    value: result.value,
    error: result.error,
  };
}

export async function getSmsProviderReadiness(
  db: Database,
  encryptionKey?: string,
): Promise<SmsProviderReadiness> {
  const vals = await readSmsSettingValues(db);
  const resolved = await instantiateSmsProvider(vals, encryptionKey);

  return {
    activeProvider: resolved.activeProvider,
    configured: Boolean(resolved.provider),
    error: resolved.error,
  };
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
  const vals = await readSmsSettingValues(db);
  const readiness = await instantiateSmsProvider(vals, encryptionKey);

  return {
    activeProvider: (vals.active_provider as SmsProviderId) ?? null,
    activeProviderConfigured: Boolean(readiness.provider),
    activeProviderError: readiness.error,
    bdbulksmsToken: vals.bdbulksms_token ? MASKED : "",
    mimsmsUsername: vals.mimsms_username ?? "",
    mimsmsApiKey: vals.mimsms_api_key ? MASKED : "",
    mimsmsSenderName: vals.mimsms_sender_name ?? "",
    smsnetbdApiKey: vals.smsnetbd_api_key ? MASKED : "",
    smsnetbdSenderId: vals.smsnetbd_sender_id ?? "",
    gennetApiToken: vals.gennet_api_token ? MASKED : "",
    gennetBaseUrl: vals.gennet_base_url ?? "",
    gennetSid: vals.gennet_sid ?? "",
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
): Promise<void> {
  validateSmsSettingsInput(data);
  const values = new Map<string, string>();

  // Plain text fields
  if (data.activeProvider !== undefined)
    values.set("active_provider", data.activeProvider);
  if (data.mimsmsUsername !== undefined)
    values.set("mimsms_username", data.mimsmsUsername);
  if (data.mimsmsSenderName !== undefined)
    values.set("mimsms_sender_name", data.mimsmsSenderName);
  if (data.smsnetbdSenderId !== undefined)
    values.set("smsnetbd_sender_id", data.smsnetbdSenderId);
  if (data.gennetBaseUrl !== undefined)
    values.set("gennet_base_url", data.gennetBaseUrl);
  if (data.gennetSid !== undefined)
    values.set("gennet_sid", data.gennetSid);

  const secrets = [
    ["bdbulksms_token", data.bdbulksmsToken],
    ["mimsms_api_key", data.mimsmsApiKey],
    ["smsnetbd_api_key", data.smsnetbdApiKey],
    ["gennet_api_token", data.gennetApiToken],
  ] as const;
  const changedSecrets = secrets.filter(([, value]) => Boolean(value && value !== MASKED));
  if (changedSecrets.length > 0 && !encryptionKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }
  for (const [key, value] of changedSecrets) {
    if (!value) continue;
    values.set(
      key,
      encodeEncryptedCredential(await encryptCredentials(value, encryptionKey!)),
    );
  }

  if (values.size === 0) return;
  const statements = [...values].map(([key, value]) =>
    db.insert(settings).values({
      id: crypto.randomUUID(),
      key,
      value,
      type: "string",
      category: SMS_CATEGORY,
    }).onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: { value, updatedAt: sql`unixepoch()` },
    })
  );
  await safeBatch(db, statements as SQLiteBatchItem[]);
}

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
  const resolved = await instantiateSmsProvider(
    await readSmsSettingValues(db),
    encryptionKey,
  );

  if (resolved.error) {
    console.error(
      `[SMS] Provider "${resolved.activeProvider ?? "none"}" is not ready: ${resolved.error}`,
    );
    return null;
  }

  return resolved.provider;
}
