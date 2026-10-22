// src/integrations/email/settings.ts
// Runtime settings for transactional email providers.

import type { Database } from "@scalius/database/client";
import { businessDocument, emailDocument, storeDisplayName } from "../../modules/settings";
import { platformDocument } from "../../modules/platform";
import { selectSettingsDocuments } from "../../settings-store";
import {
  readiness,
  readinessIssue,
  type Readiness,
  type ReadinessIssue,
} from "@scalius/shared/readiness";
import { isAppProviderId, resolveAppProvider } from "../provider-port";
import { BUILT_IN_EMAIL_PROVIDER_IDS, type EmailRuntimeContext, type EmailRuntimeSettings } from "./provider";

const DEFAULT_FROM = "noreply@example.com";
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

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
  /** The chosen sender (an app provider's id for an app), or `mailpit` in local development. */
  provider: string;
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

export async function getEmailRuntimeSettings(
  context?: EmailRuntimeContext,
): Promise<EmailRuntimeSettings> {
  if (context?.settings) return context.settings;

  try {
    const db = await resolveDb(context);
    // One read for the email document and the store's display name, the sender name.
    const rows = await selectSettingsDocuments(db, [emailDocument, businessDocument, platformDocument]);
    const ctx = { encryptionKey: encryptionKeyFromContext(context) };
    const [stored, business, platform] = await Promise.all([
      emailDocument.fromRows(rows, ctx),
      businessDocument.fromRows(rows, ctx),
      platformDocument.fromRows(rows, ctx),
    ]);
    const senderName = storeDisplayName(business.value, platform.value.storefrontUrl) ?? "";

    const resendCredentialError = stored.secretErrors.resendApiKey ?? null;
    const resendApiKey = stored.value.resendApiKey || null;
    const provider = stored.value.provider || (resendApiKey ? "resend" : "cloudflare");
    const rawSender = stored.value.sender.trim();
    const senderConfigured = EMAIL_ADDRESS_PATTERN.test(rawSender);
    const localMailpitUrl = resolveLocalMailpitUrl(context?.env?.LOCAL_MAILPIT_URL);

    return {
      provider,
      sender: rawSender || DEFAULT_FROM,
      senderName,
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

/** A choice the email settings can save: a built-in sender or an app provider id. */
export function isEmailProviderChoice(id: string): boolean {
  return (BUILT_IN_EMAIL_PROVIDER_IDS as readonly string[]).includes(id) || isAppProviderId(id);
}

/** Why the chosen sender cannot send, or null when it can. An app choice is asked through the context's AppProviders. */
async function selectedProviderIssue(
  settings: EmailRuntimeSettings,
  context: EmailRuntimeContext | undefined,
): Promise<string | null> {
  if (settings.localMailpitUrl) return null;
  if (isAppProviderId(settings.provider)) {
    return (await resolveAppProvider(context?.appProviders, "email", settings.provider)).issue;
  }
  if (settings.provider === "cloudflare") {
    return settings.cloudflareBindingConfigured
      ? null
      : "The selected Cloudflare Email provider requires the EMAIL binding.";
  }
  return settings.hasResendApiKey
    ? null
    : settings.resendCredentialError ?? "The selected Resend provider requires a Resend API key.";
}

export async function getEmailProviderReadiness(
  context?: EmailRuntimeContext,
): Promise<EmailProviderReadiness> {
  const settings = await getEmailRuntimeSettings(context);
  const issues: ReadinessIssue[] = [];

  // A local Mailpit captures every message, signed with the default sender when
  // none is saved (as sending does): a fresh local store can deliver email,
  // sign-in codes included, before the merchant sets a real sender.
  if (!settings.senderConfigured && !settings.localMailpitUrl) {
    issues.push(readinessIssue(
      EMAIL_READINESS_CODES.missingSender,
      "Sender email is required before enabling email delivery.",
    ));
  }

  const providerIssue = await selectedProviderIssue(settings, context);
  if (providerIssue) {
    issues.push(readinessIssue(EMAIL_READINESS_CODES.missingProvider, providerIssue));
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
