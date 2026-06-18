// src/integrations/email/settings.ts
// Runtime settings for transactional email providers.

import type { Database } from "@scalius/database/client";
import { settings as settingsTable } from "@scalius/database/schema";
import { decryptCredentialsGraceful } from "@scalius/core/utils/credential-encryption";
import { and, eq } from "drizzle-orm";
import type { EmailRuntimeContext, EmailRuntimeSettings } from "./provider";

const DEFAULT_FROM = "noreply@example.com";

function encryptionKeyFromContext(context?: EmailRuntimeContext): string | undefined {
  return context?.encryptionKey
    ?? context?.env?.CREDENTIAL_ENCRYPTION_KEY
    ?? context?.env?.JWT_SECRET;
}

async function resolveDb(context?: EmailRuntimeContext): Promise<Database> {
  if (context?.db) return context.db as Database;
  const { getDb } = await import("@scalius/database/client");
  return getDb(context?.env);
}

export async function getEmailRuntimeSettings(
  context?: EmailRuntimeContext,
): Promise<EmailRuntimeSettings> {
  if (context?.settings) return context.settings;

  try {
    const db = await resolveDb(context);
    const rows = await db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(eq(settingsTable.category, "email"))
      .all();

    const values = new Map(rows.map((row) => [row.key, row.value]));
    const storedResendApiKey = values.get("resend_api_key") || "";
    const resendApiKey = storedResendApiKey
      ? await decryptCredentialsGraceful(storedResendApiKey, encryptionKeyFromContext(context))
      : null;
    const savedProvider = values.get("email_provider");
    const provider = savedProvider === "cloudflare" || savedProvider === "resend"
      ? savedProvider
      : resendApiKey
        ? "resend"
        : "cloudflare";

    return {
      provider,
      sender: values.get("email_sender") || DEFAULT_FROM,
      resendApiKey,
      hasResendApiKey: Boolean(resendApiKey),
      cloudflareBindingConfigured: Boolean(context?.env?.EMAIL),
    };
  } catch (error: unknown) {
    console.error("[Email] Failed to load email settings from DB:", error);
    return {
      provider: context?.env?.EMAIL ? "cloudflare" : "resend",
      sender: DEFAULT_FROM,
      resendApiKey: null,
      hasResendApiKey: false,
      cloudflareBindingConfigured: Boolean(context?.env?.EMAIL),
    };
  }
}

export async function readEmailSetting(
  db: Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .select({ value: settingsTable.value })
    .from(settingsTable)
    .where(and(eq(settingsTable.key, key), eq(settingsTable.category, "email")))
    .get();
  return row?.value || null;
}
