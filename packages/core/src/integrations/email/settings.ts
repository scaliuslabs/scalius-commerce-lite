// src/integrations/email/settings.ts
// Runtime settings for transactional email providers.

import { z } from "zod";
import type { Database } from "@scalius/database/client";
import { settings as settingsTable } from "@scalius/database/schema";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { defineSettingsDocument } from "@scalius/core/modules/settings/settings-store";
import { eq } from "drizzle-orm";
import {
  readiness,
  readinessIssue,
  type Readiness,
  type ReadinessIssue,
} from "@scalius/shared/readiness";
import type { EmailRuntimeContext, EmailRuntimeSettings } from "./provider";

const DEFAULT_FROM = "noreply@example.com";
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EMAIL_SENDER_MAX_LENGTH = 320;
const EMAIL_API_KEY_MAX_LENGTH = 512;

/** Stable issue codes for email delivery setup. */
export const EMAIL_READINESS_CODES = {
  missingSender: "missing_email_sender",
  missingProvider: "missing_email_provider_credentials",
} as const;

/**
 * The shared readiness vocabulary plus the typed extras the email settings
 * screen renders.
 */
export interface EmailProviderReadiness extends Readiness {
  provider: EmailRuntimeSettings["provider"] | "mailpit";
  sender: string;
  senderConfigured: boolean;
  cloudflareBindingConfigured: boolean;
  resendConfigured: boolean;
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

/** Storage keys used before the settings document existed. */
const LEGACY_EMAIL_SETTING_KEYS = {
  provider: "email_provider",
  sender: "email_sender",
  resendApiKey: "resend_api_key",
} as const;

export interface EmailSettingsDocument extends Record<string, unknown> {
  /** Empty means "not explicitly chosen"; the provider is then inferred. */
  provider: "" | "cloudflare" | "resend";
  sender: string;
  resendApiKey: string;
}

/**
 * Transactional email provider settings. The Resend API key is the only
 * secret, so the document is never cached; readiness and delivery both read
 * it through the strict credential reader.
 */
export const emailSettingsDocument = defineSettingsDocument<EmailSettingsDocument>({
  category: "email",
  key: "config",
  label: "email provider",
  schema: z.object({
    provider: z.enum(["", "cloudflare", "resend"]),
    sender: z.string().max(EMAIL_SENDER_MAX_LENGTH),
    resendApiKey: z.string().max(EMAIL_API_KEY_MAX_LENGTH),
  }),
  defaults: { provider: "", sender: "", resendApiKey: "" },
  secretFields: ["resendApiKey"],
  // Email readiness is projected into the cached public checkout config.
  legacy: {
    async read(db, ctx) {
      const rows = await db
        .select({ key: settingsTable.key, value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.category, "email"))
        .all();
      const values = new Map(rows.map((row) => [row.key, row.value]));
      const legacyKeys = Object.values(LEGACY_EMAIL_SETTING_KEYS);
      if (!legacyKeys.some((key) => values.has(key))) return null;

      const storedProvider = values.get(LEGACY_EMAIL_SETTING_KEYS.provider);
      const storedApiKey = values.get(LEGACY_EMAIL_SETTING_KEYS.resendApiKey) || "";
      const resolved = await readStoredCredentialStrict(
        storedApiKey,
        ctx.encryptionKey,
        "Resend API key",
      );

      return {
        document: {
          provider:
            storedProvider === "cloudflare" || storedProvider === "resend"
              ? storedProvider
              : "",
          sender: (values.get(LEGACY_EMAIL_SETTING_KEYS.sender) || "").trim(),
          resendApiKey: resolved.error ? "" : resolved.value,
        },
        // A key that cannot be read must not be replaced by an empty document.
        migrate: !resolved.error && Boolean(ctx.encryptionKey || !storedApiKey),
        secretErrors: resolved.error ? { resendApiKey: resolved.error } : {},
        secretsConfigured: { resendApiKey: !resolved.error && Boolean(resolved.value) },
      };
    },
  },
});

export async function getEmailRuntimeSettings(
  context?: EmailRuntimeContext,
): Promise<EmailRuntimeSettings> {
  if (context?.settings) return context.settings;

  try {
    const db = await resolveDb(context);
    const stored = await emailSettingsDocument.readDetailed(db, {
      encryptionKey: encryptionKeyFromContext(context),
    });

    const resendCredentialError = stored.secretErrors.resendApiKey ?? null;
    const resendApiKey = stored.value.resendApiKey || null;
    const provider = stored.value.provider || (resendApiKey ? "resend" : "cloudflare");
    const rawSender = stored.value.sender.trim();
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
      resendCredentialError,
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
  const issues: ReadinessIssue[] = [];
  const selectedProviderConfigured = Boolean(settings.localMailpitUrl)
    || (settings.provider === "cloudflare"
      ? settings.cloudflareBindingConfigured
      : settings.hasResendApiKey);

  if (!settings.senderConfigured) {
    issues.push(readinessIssue(
      EMAIL_READINESS_CODES.missingSender,
      "Sender email is required before enabling email delivery.",
    ));
  }

  if (!selectedProviderConfigured) {
    issues.push(readinessIssue(
      EMAIL_READINESS_CODES.missingProvider,
      settings.provider === "resend"
        ? settings.resendCredentialError
          ?? "The selected Resend provider requires a Resend API key."
        : "The selected Cloudflare Email provider requires the EMAIL binding.",
    ));
  }

  const value = readiness.from(issues);
  return {
    ...value,
    provider: settings.localMailpitUrl ? "mailpit" : settings.provider,
    sender: settings.sender,
    senderConfigured: settings.senderConfigured,
    cloudflareBindingConfigured: settings.cloudflareBindingConfigured,
    resendConfigured: settings.hasResendApiKey,
  };
}
