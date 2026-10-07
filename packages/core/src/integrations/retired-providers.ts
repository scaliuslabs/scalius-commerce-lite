// Built-in providers that moved into an app, and where their saved
// configuration goes (docs/platform/PLUGINS.md, "Retired built-in
// providers"). Core has no SMS gateway or fraud checker of its own: the
// Bangladesh ones are providers of the Bangladesh pack (`scalius.bangladesh`).
//
// Two uses, both for stores that saved a built-in choice before the move:
// - A saved choice that still names a retired id resolves to the app provider
//   that replaced it. While that app is not installed, active and set up, the
//   choice fails closed with the app's reason ("Activate Bangladesh pack in
//   Apps to use it."), never a silent fallback.
// - When that app is activated, the host moves the old configuration into the
//   app's settings (apps/api/src/plugins/provider-handoff.ts) and repoints the
//   saved choice. After that nothing here is read for that store.
//
// Data only: no provider code, no network. Delete an entry once no store can
// still hold its old configuration.

import { qualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";

/** The app that took over the retired built-in providers below. */
export const BANGLADESH_PACK_ID = "scalius.bangladesh";

/** One retired built-in provider: the app provider that replaced it and where each old field goes. */
export interface RetiredProvider {
  /** `<plugin id>:<provider id>`. */
  replacement: string;
  /** The old stored field (SMS document field, or fraud-checker row field) → the app's setting key. */
  settings: Readonly<Record<string, string>>;
}

const pack = (providerId: string) => qualifiedProviderId(BANGLADESH_PACK_ID, providerId);

/** Retired built-in SMS gateways, by their old id (`sms` settings document fields). */
export const RETIRED_SMS_PROVIDERS: Readonly<Record<string, RetiredProvider>> = {
  smsnetbd: { replacement: pack("smsnetbd"), settings: { smsnetbdApiKey: "smsnetbd_api_key", smsnetbdSenderId: "smsnetbd_sender_id" } },
  bdbulksms: { replacement: pack("bdbulksms"), settings: { bdbulksmsToken: "bdbulksms_token" } },
  mimsms: {
    replacement: pack("mimsms"),
    settings: { mimsmsUsername: "mimsms_username", mimsmsApiKey: "mimsms_api_key", mimsmsSenderName: "mimsms_sender_name" },
  },
  gennet: {
    replacement: pack("gennet"),
    settings: { gennetApiToken: "gennet_api_token", gennetBaseUrl: "gennet_base_url", gennetSid: "gennet_sid" },
  },
};

/** The secret fields among the retired SMS fields (encrypted one by one in the `sms` document). */
export const RETIRED_SMS_SECRET_FIELDS: readonly string[] = ["smsnetbdApiKey", "bdbulksmsToken", "mimsmsApiKey", "gennetApiToken"];

/**
 * Retired built-in fraud checkers, by their old `providerType` (an empty type
 * was the custom API). Fields are a `fraud-checker` row's decrypted JSON.
 */
export const RETIRED_FRAUD_PROVIDERS: Readonly<Record<string, RetiredProvider>> = {
  default: { replacement: pack("fraudchecker"), settings: { apiUrl: "fraudchecker_api_url", apiKey: "fraudchecker_token" } },
  fraudbd: {
    replacement: pack("fraudbd"),
    settings: { apiUrl: "fraudbd_api_url", apiKey: "fraudbd_api_key", userId: "fraudbd_username", apiSecret: "fraudbd_password" },
  },
  fraudguard: {
    replacement: pack("fraudguard"),
    settings: { apiUrl: "fraudguard_api_url", apiKey: "fraudguard_api_key", apiSecret: "fraudguard_api_secret" },
  },
  ecourier: {
    replacement: pack("ecourier"),
    settings: { apiUrl: "ecourier_api_url", apiKey: "ecourier_api_key", apiSecret: "ecourier_api_secret", userId: "ecourier_user_id" },
  },
};

/** The app provider a retired built-in id now means, or null when the id is not a retired one. */
export function retiredProviderReplacement(kind: "sms" | "fraud", id: string | null | undefined): string | null {
  const table = kind === "sms" ? RETIRED_SMS_PROVIDERS : RETIRED_FRAUD_PROVIDERS;
  const key = kind === "fraud" ? (id || "default") : id;
  return key && Object.hasOwn(table, key) ? table[key]!.replacement : null;
}
