// src/integrations/sms/sms-settings.ts
// SMS settings service for reading/writing encrypted credentials from/to
// the `settings` table (category "sms"). Follows gateway-settings.ts pattern.
//
// SECURITY: Decrypted credentials are NEVER written to KV or any persistent
// store. In-memory cache is scoped to the Worker isolate lifetime and is
// automatically cleared on cold start.

import { eq } from "drizzle-orm";
import { settings } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import {
  upsertSetting,
  upsertEncryptedSetting,
} from "@scalius/core/modules/payments/gateway-settings";
import { decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";
import type { SmsProvider, SmsProviderId } from "./provider";

// ---------------------------------------------------------------------------
// In-memory credential cache (per-isolate, lost on cold start)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SMS_CATEGORY = "sms";
const SMS_CACHE_KEY = "sms:active";
const MASKED = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"; // 12 bullet chars

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsSettingsData {
  activeProvider: SmsProviderId | null;
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

// ---------------------------------------------------------------------------
// Read settings (masked secrets)
// ---------------------------------------------------------------------------

/**
 * Read all SMS settings from DB.
 * Encrypted fields are returned as MASKED when configured, empty string when not.
 */
export async function getSmsSettings(
  db: Database,
): Promise<SmsSettingsData> {
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, SMS_CATEGORY))
    .all();

  const vals = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  return {
    activeProvider: (vals.active_provider as SmsProviderId) ?? null,
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
  const ops: Promise<void>[] = [];

  // Plain text fields
  if (data.activeProvider !== undefined)
    ops.push(
      upsertSetting(db, SMS_CATEGORY, "active_provider", data.activeProvider),
    );
  if (data.mimsmsUsername !== undefined)
    ops.push(
      upsertSetting(db, SMS_CATEGORY, "mimsms_username", data.mimsmsUsername),
    );
  if (data.mimsmsSenderName !== undefined)
    ops.push(
      upsertSetting(
        db,
        SMS_CATEGORY,
        "mimsms_sender_name",
        data.mimsmsSenderName,
      ),
    );
  if (data.smsnetbdSenderId !== undefined)
    ops.push(
      upsertSetting(
        db,
        SMS_CATEGORY,
        "smsnetbd_sender_id",
        data.smsnetbdSenderId,
      ),
    );
  if (data.gennetBaseUrl !== undefined)
    ops.push(
      upsertSetting(db, SMS_CATEGORY, "gennet_base_url", data.gennetBaseUrl),
    );
  if (data.gennetSid !== undefined)
    ops.push(upsertSetting(db, SMS_CATEGORY, "gennet_sid", data.gennetSid));

  // Encrypted fields — skip if masked (means user did not change them)
  if (data.bdbulksmsToken && data.bdbulksmsToken !== MASKED)
    ops.push(
      upsertEncryptedSetting(
        db,
        SMS_CATEGORY,
        "bdbulksms_token",
        data.bdbulksmsToken,
        encryptionKey,
      ),
    );
  if (data.mimsmsApiKey && data.mimsmsApiKey !== MASKED)
    ops.push(
      upsertEncryptedSetting(
        db,
        SMS_CATEGORY,
        "mimsms_api_key",
        data.mimsmsApiKey,
        encryptionKey,
      ),
    );
  if (data.smsnetbdApiKey && data.smsnetbdApiKey !== MASKED)
    ops.push(
      upsertEncryptedSetting(
        db,
        SMS_CATEGORY,
        "smsnetbd_api_key",
        data.smsnetbdApiKey,
        encryptionKey,
      ),
    );
  if (data.gennetApiToken && data.gennetApiToken !== MASKED)
    ops.push(
      upsertEncryptedSetting(
        db,
        SMS_CATEGORY,
        "gennet_api_token",
        data.gennetApiToken,
        encryptionKey,
      ),
    );

  await Promise.all(ops);
  invalidateSmsCache();
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
  // Check in-memory cache
  const cached = getCachedCredential<SmsProvider>(SMS_CACHE_KEY);
  if (cached) return cached;

  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.category, SMS_CATEGORY))
    .all();

  const vals = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const providerName = vals.active_provider;
  if (!providerName) return null;

  // Import provider classes and instantiate with decrypted credentials
  let provider: SmsProvider | null = null;

  switch (providerName) {
    case "smsnetbd": {
      const { SmsNetBdProvider } = await import("./providers/smsnetbd");
      provider = new SmsNetBdProvider({
        apiKey: await decryptCredentialsGraceful(
          vals.smsnetbd_api_key ?? "",
          encryptionKey,
        ),
        senderId: vals.smsnetbd_sender_id || undefined,
      });
      break;
    }
    case "bdbulksms": {
      const { BdBulkSmsProvider } = await import("./providers/bdbulksms");
      provider = new BdBulkSmsProvider({
        token: await decryptCredentialsGraceful(
          vals.bdbulksms_token ?? "",
          encryptionKey,
        ),
      });
      break;
    }
    case "mimsms": {
      const { MimSmsProvider } = await import("./providers/mimsms");
      provider = new MimSmsProvider({
        userName: vals.mimsms_username ?? "",
        apiKey: await decryptCredentialsGraceful(
          vals.mimsms_api_key ?? "",
          encryptionKey,
        ),
        senderName: vals.mimsms_sender_name ?? "",
      });
      break;
    }
    case "gennet": {
      const { GennetProvider } = await import("./providers/gennet");
      provider = new GennetProvider({
        apiToken: await decryptCredentialsGraceful(
          vals.gennet_api_token ?? "",
          encryptionKey,
        ),
        baseUrl: vals.gennet_base_url ?? "",
        sid: vals.gennet_sid ?? "",
      });
      break;
    }
  }

  if (provider) {
    const validationError = provider.validateConfig();
    if (validationError) {
      console.error(
        `[SMS] Provider "${providerName}" configured but invalid: ${validationError}`,
      );
      return null;
    }
    setCachedCredential(SMS_CACHE_KEY, provider);
  }

  return provider;
}

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

/** Invalidate the SMS provider cache (call after saving new settings). */
export function invalidateSmsCache(): void {
  credentialCache.delete(SMS_CACHE_KEY);
}
