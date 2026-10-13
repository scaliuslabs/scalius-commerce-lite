// src/integrations/sms/sms-settings.ts
// The merchant's SMS gateway choice (the `sms` settings document) resolved to
// one SMS port. Every gateway is an app provider (`<plugin id>:<provider id>`)
// reached through the request's AppProviders; its keys live in the app's own
// settings, encrypted.
//
// SECURITY: nothing here decrypts or logs a credential. Dispatch reads the
// authoritative document for every send, so a changed choice is never stale.

import {
  readiness,
  readinessIssue,
  type Readiness,
} from "@scalius/shared/readiness";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { smsDocument } from "../../modules/settings";
import { isAppProviderId, resolveAppProvider, type AppProviders } from "../provider-port";
import type { SmsProvider } from "./port";

/** A choice the SMS settings can save: an app provider id. */
export function isSmsProviderChoice(id: string): boolean {
  return isAppProviderId(id);
}

export interface SmsSettingsData {
  /** An app provider's `<plugin id>:<provider id>`, or null when none is chosen. */
  activeProvider: string | null;
  activeProviderConfigured: boolean;
  activeProviderError: string | null;
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

interface ResolvedSms {
  activeProvider: string | null;
  provider: SmsProvider | null;
  error: string | null;
}

/** The merchant's saved choice as one SMS port, or why it cannot send. */
async function resolveSmsProvider(db: Database, apps: AppProviders | undefined): Promise<ResolvedSms & { revision: number }> {
  const stored = await smsDocument.readDetailed(db);
  const revision = stored.revision;
  const activeProvider = stored.value.activeProvider?.trim() || null;
  if (!activeProvider) {
    return { activeProvider: null, provider: null, error: "No active SMS provider selected", revision };
  }
  if (!isAppProviderId(activeProvider)) {
    return { activeProvider: null, provider: null, error: `Unsupported SMS provider "${activeProvider}"`, revision };
  }
  const choice = await resolveAppProvider(apps, "sms", activeProvider);
  return { activeProvider, provider: choice.provider, error: choice.issue, revision };
}

export async function getSmsProviderReadiness(
  db: Database,
  _encryptionKey?: string,
  apps?: AppProviders,
): Promise<SmsProviderReadiness> {
  const resolved = await resolveSmsProvider(db, apps);
  const value = resolved.provider
    ? readiness.ready()
    : readiness.incomplete([readinessIssue(
        SMS_READINESS_CODE,
        resolved.error ?? "Configure an SMS provider before sending SMS messages.",
      )]);
  return { ...value, activeProvider: resolved.activeProvider };
}

/** The saved choice and whether it can send now. */
export async function getSmsSettings(
  db: Database,
  _encryptionKey?: string,
  apps?: AppProviders,
): Promise<SmsSettingsData> {
  const resolved = await resolveSmsProvider(db, apps);
  return {
    activeProvider: resolved.activeProvider,
    activeProviderConfigured: Boolean(resolved.provider),
    activeProviderError: resolved.error,
    revision: resolved.revision,
  };
}

export type SmsSettingsInput = Partial<{ activeProvider: string }>;

/**
 * Saves the gateway choice; the caller checks that an installed app declares
 * it. The gateway's keys are the app's settings.
 */
export async function saveSmsSettings(
  db: Database,
  data: SmsSettingsInput,
  _encryptionKey?: string,
  /** The revision the editor loaded; a stale one is a 409 conflict. */
  options: { expectedRevision?: number } = {},
): Promise<{ revision: number }> {
  if (data.activeProvider && !isSmsProviderChoice(data.activeProvider)) {
    throw new ValidationError("Unsupported SMS provider.");
  }
  const patch = data.activeProvider === undefined ? {} : { activeProvider: data.activeProvider };
  const { revision } = await smsDocument.write(db, patch, {}, options);
  return { revision };
}

/**
 * The SMS provider to send through, or null (never a throw) when the saved
 * choice cannot send: no choice, an app that is not installed, active and
 * set up, or no app lookup here. Nothing is sent then.
 */
export async function getActiveSmsProvider(
  db: Database,
  _encryptionKey?: string,
  apps?: AppProviders,
): Promise<SmsProvider | null> {
  const resolved = await resolveSmsProvider(db, apps);
  if (resolved.error) {
    console.error(`[SMS] Provider "${resolved.activeProvider ?? "none"}" is not ready: ${resolved.error}`);
    return null;
  }
  return resolved.provider;
}
