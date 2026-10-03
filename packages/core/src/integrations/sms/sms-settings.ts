// src/integrations/sms/sms-settings.ts
// SMS provider settings (the `sms` settings document) and the merchant's
// choice resolved to one SMS port: a built-in gateway with its credentials,
// or an app provider (`<plugin id>:<provider id>`) through the request's
// AppProviders, asked only when the saved choice names an app.
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
import { smsDocument, type SmsSettings } from "../../modules/settings";
import { bindProvider, isAppProviderId, resolveAppProvider, type AppProviders } from "../provider-port";
import { MASKED_SMS_SECRET as MASKED, firstPlaceholderConfigError } from "./credentials";
import {
  BUILT_IN_SMS_PROVIDER_IDS,
  type BuiltInSmsProviderId,
  type SmsAdapter,
  type SmsProvider,
  type StoredSms,
} from "./port";
import { bdBulkSms } from "./providers/bdbulksms";
import { gennetSms } from "./providers/gennet";
import { mimSms } from "./providers/mimsms";
import { smsNetBdSms } from "./providers/smsnetbd";

/** The built-in gateways, by id. */
const BUILT_IN_SMS_ADAPTERS: Record<BuiltInSmsProviderId, SmsAdapter<unknown>> = {
  smsnetbd: smsNetBdSms,
  bdbulksms: bdBulkSms,
  mimsms: mimSms,
  gennet: gennetSms,
};

function isBuiltInSmsProviderId(id: string): id is BuiltInSmsProviderId {
  return (BUILT_IN_SMS_PROVIDER_IDS as readonly string[]).includes(id);
}

/** A choice the SMS settings can save: a built-in gateway or an app provider id. */
export function isSmsProviderChoice(id: string): boolean {
  return isBuiltInSmsProviderId(id) || isAppProviderId(id);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsSettingsData {
  /** A built-in gateway id or an app provider's `<plugin id>:<provider id>`. */
  activeProvider: string | null;
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
  activeProvider: string | null;
}

async function readSms(db: Database, encryptionKey?: string): Promise<StoredSms> {
  return smsDocument.readDetailed(db, { encryptionKey });
}

interface ResolvedSms {
  activeProvider: string | null;
  provider: SmsProvider | null;
  error: string | null;
}

/** The merchant's saved choice as one SMS port, or why it cannot send. */
async function resolveSmsProvider(stored: StoredSms, apps: AppProviders | undefined): Promise<ResolvedSms> {
  const activeProvider = stored.value.activeProvider || null;
  if (!activeProvider) {
    return { activeProvider: null, provider: null, error: "No active SMS provider selected" };
  }
  if (isAppProviderId(activeProvider)) {
    const choice = await resolveAppProvider(apps, "sms", activeProvider);
    return { activeProvider, provider: choice.provider, error: choice.issue };
  }
  if (!isBuiltInSmsProviderId(activeProvider)) {
    return { activeProvider: null, provider: null, error: `Unsupported SMS provider "${activeProvider}"` };
  }
  const adapter = BUILT_IN_SMS_ADAPTERS[activeProvider];
  const configured = adapter.configure(stored);
  if ("error" in configured) return { activeProvider, provider: null, error: configured.error };
  return { activeProvider, provider: bindProvider("sms", adapter, configured.settings), error: null };
}

export async function getSmsProviderReadiness(
  db: Database,
  encryptionKey?: string,
  apps?: AppProviders,
): Promise<SmsProviderReadiness> {
  const resolved = await resolveSmsProvider(await readSms(db, encryptionKey), apps);
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
  apps?: AppProviders,
): Promise<SmsSettingsData> {
  const stored = await readSms(db, encryptionKey);
  const resolved = await resolveSmsProvider(stored, apps);
  const vals = stored.value;
  // A secret is "stored" even when this request cannot decrypt it.
  const masked = (field: keyof SmsSettings) =>
    vals[field] || stored.secretErrors[field] ? MASKED : "";

  return {
    activeProvider: vals.activeProvider || null,
    activeProviderConfigured: Boolean(resolved.provider),
    activeProviderError: resolved.error,
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

export type SmsSettingsInput = Partial<{
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
}>;

/**
 * Save SMS settings. Only writes fields that are provided and not masked.
 * An app provider id is accepted as the active provider; the caller checks
 * that an installed app declares it.
 */
export async function saveSmsSettings(
  db: Database,
  data: SmsSettingsInput,
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

function validateSmsSettingsInput(data: SmsSettingsInput): void {
  if (data.activeProvider && !isSmsProviderChoice(data.activeProvider)) {
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
// Active provider resolver (used at dispatch time)
// ---------------------------------------------------------------------------

/**
 * The SMS provider to send through: the saved choice with its credentials
 * read (and decrypted) now; an app provider through `apps`. Returns null
 * (does not throw) when no provider can send.
 */
export async function getActiveSmsProvider(
  db: Database,
  encryptionKey?: string,
  apps?: AppProviders,
): Promise<SmsProvider | null> {
  const resolved = await resolveSmsProvider(await readSms(db, encryptionKey), apps);

  if (resolved.error) {
    console.error(
      `[SMS] Provider "${resolved.activeProvider ?? "none"}" is not ready: ${resolved.error}`,
    );
    return null;
  }

  return resolved.provider;
}
