// The SMS port as core calls it: the shared port
// (`@scalius/shared/plugins/providers/messaging`, the same one app providers
// implement) bound to the merchant's saved choice. Built-in gateways are one
// adapter in ./providers plus one entry in BUILT_IN_SMS_ADAPTERS
// (sms-settings.ts); app providers (`<plugin id>:<provider id>`) join through
// the request's AppProviders. Senders call `send` and never ask which it is.

import type { SmsSettings } from "../../modules/settings";
import type { SettingsDocumentReadResult } from "../../settings-store";
import type { BoundProvider, BuiltInAdapter } from "../provider-port";

/** The built-in gateways, in the order the dashboard lists them. */
export const BUILT_IN_SMS_PROVIDER_IDS = ["smsnetbd", "bdbulksms", "mimsms", "gennet"] as const;
export type BuiltInSmsProviderId = (typeof BUILT_IN_SMS_PROVIDER_IDS)[number];

/** The SMS provider a send goes through: a built-in gateway with its credentials, or an app's. */
export type SmsProvider = BoundProvider<"sms">;

/** The `sms` settings document as read, secrets decrypted strictly. */
export type StoredSms = SettingsDocumentReadResult<SmsSettings>;

/**
 * A built-in gateway. It reads its own credentials from the `sms` document
 * and must refuse missing, unreadable or placeholder ones (fail closed).
 */
export type SmsAdapter<S> = BuiltInAdapter<"sms", S> & {
  readonly id: BuiltInSmsProviderId;
  /** The gateway's settings, or why they cannot be used (merchant-facing). */
  configure(stored: StoredSms): { settings: S } | { error: string };
};
