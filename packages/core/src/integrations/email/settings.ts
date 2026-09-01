// src/integrations/email/settings.ts
// Runtime settings for transactional email providers.

import type { Database } from "@scalius/database/client";
import { settings as settingsTable } from "@scalius/database/schema";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { and, eq } from "drizzle-orm";
import type { EmailRuntimeContext, EmailRuntimeSettings } from "./provider";

const DEFAULT_FROM = "noreply@example.com";
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface EmailProviderReadiness {
  configured: boolean;
  provider: EmailRuntimeSettings["provider"] | "mailpit";
  sender: string;
  senderConfigured: boolean;
  cloudflareBindingConfigured: boolean;
  resendConfigured: boolean;
  error: string | null;
  blockers: string[];
}

export function resolveLocalMailpitUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "http:"
      || !LOOPBACK_HOSTS.has(url.hostname)
      || url.username
      || url.password
      || (url.pathname !== "/" && url.pathname !== "")
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
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
    const localMailpitUrl = resolveLocalMailpitUrl(context?.env?.LOCAL_MAILPIT_URL);

    return {
      provider,
      sender: rawSender || DEFAULT_FROM,
      senderConfigured,
      resendApiKey,
      hasResendApiKey: Boolean(resendApiKey),
      cloudflareBindingConfigured: Boolean(context?.env?.EMAIL),
      localMailpitUrl,
      resendCredentialError: resolvedResendApiKey.error ?? null,
    };
  } catch (error: unknown) {
    console.error("[Email] Failed to load email settings from DB:", error);
    const localMailpitUrl = resolveLocalMailpitUrl(context?.env?.LOCAL_MAILPIT_URL);
    return {
      provider: context?.env?.EMAIL ? "cloudflare" : "resend",
      sender: DEFAULT_FROM,
      senderConfigured: false,
      resendApiKey: null,
      hasResendApiKey: false,
      cloudflareBindingConfigured: Boolean(context?.env?.EMAIL),
      localMailpitUrl,
      resendCredentialError: null,
    };
  }
}

export async function getEmailProviderReadiness(
  context?: EmailRuntimeContext,
): Promise<EmailProviderReadiness> {
  const settings = await getEmailRuntimeSettings(context);
  const blockers: string[] = [];
  const selectedProviderConfigured = Boolean(settings.localMailpitUrl)
    || (settings.provider === "cloudflare"
      ? settings.cloudflareBindingConfigured
      : settings.hasResendApiKey);

  if (!settings.senderConfigured) {
    blockers.push("Sender email is required before enabling email delivery.");
  }

  if (!selectedProviderConfigured) {
    blockers.push(
      settings.provider === "resend"
        ? settings.resendCredentialError
          ?? "The selected Resend provider requires a Resend API key."
        : "The selected Cloudflare Email provider requires the EMAIL binding.",
    );
  }

  return {
    configured: blockers.length === 0,
    provider: settings.localMailpitUrl ? "mailpit" : settings.provider,
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
