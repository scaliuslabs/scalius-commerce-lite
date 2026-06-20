// src/integrations/email/settings.ts
// Runtime settings for transactional email providers.

import type { Database } from "@scalius/database/client";
import { settings as settingsTable } from "@scalius/database/schema";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { and, eq } from "drizzle-orm";
import type { EmailRuntimeContext, EmailRuntimeSettings } from "./provider";

const DEFAULT_FROM = "noreply@example.com";
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailProviderReadiness {
  configured: boolean;
  provider: EmailRuntimeSettings["provider"];
  sender: string;
  senderConfigured: boolean;
  cloudflareBindingConfigured: boolean;
  resendConfigured: boolean;
  error: string | null;
  blockers: string[];
}

function encryptionKeyFromContext(context?: EmailRuntimeContext): string | undefined {
  return context?.encryptionKey
    ?? context?.env?.CREDENTIAL_ENCRYPTION_KEY;
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
    const resolvedResendApiKey = await readStoredCredentialStrict(
      storedResendApiKey,
      encryptionKeyFromContext(context),
      "Resend API key",
    );
    if (resolvedResendApiKey.error) {
      console.warn("[Email] Resend API key is not ready:", resolvedResendApiKey.error);
    }
    const resendApiKey = resolvedResendApiKey.error || !resolvedResendApiKey.value
      ? null
      : resolvedResendApiKey.value;
    const savedProvider = values.get("email_provider");
    const provider = savedProvider === "cloudflare" || savedProvider === "resend"
      ? savedProvider
      : resendApiKey
        ? "resend"
        : "cloudflare";
    const rawSender = (values.get("email_sender") || "").trim();
    const senderConfigured = EMAIL_ADDRESS_PATTERN.test(rawSender);

    return {
      provider,
      sender: rawSender || DEFAULT_FROM,
      senderConfigured,
      resendApiKey,
      hasResendApiKey: Boolean(resendApiKey),
      cloudflareBindingConfigured: Boolean(context?.env?.EMAIL),
      resendCredentialError: resolvedResendApiKey.error ?? null,
    };
  } catch (error: unknown) {
    console.error("[Email] Failed to load email settings from DB:", error);
    return {
      provider: context?.env?.EMAIL ? "cloudflare" : "resend",
      sender: DEFAULT_FROM,
      senderConfigured: false,
      resendApiKey: null,
      hasResendApiKey: false,
      cloudflareBindingConfigured: Boolean(context?.env?.EMAIL),
      resendCredentialError: null,
    };
  }
}

export async function getEmailProviderReadiness(
  context?: EmailRuntimeContext,
): Promise<EmailProviderReadiness> {
  const settings = await getEmailRuntimeSettings(context);
  const blockers: string[] = [];
  const hasProvider = settings.cloudflareBindingConfigured || settings.hasResendApiKey;

  if (!settings.senderConfigured) {
    blockers.push("Sender email is required before enabling Email OTP.");
  }

  if (!hasProvider) {
    blockers.push(
      settings.resendCredentialError
        ? settings.resendCredentialError
        : "Configure Cloudflare Email or save a Resend API key before enabling Email OTP.",
    );
  }

  return {
    configured: blockers.length === 0,
    provider: settings.provider,
    sender: settings.sender,
    senderConfigured: settings.senderConfigured,
    cloudflareBindingConfigured: settings.cloudflareBindingConfigured,
    resendConfigured: settings.hasResendApiKey,
    error: blockers[0] ?? null,
    blockers,
  };
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
