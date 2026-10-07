// Built-in providers that moved into an app, and where their saved
// configuration goes (docs/platform/PLUGINS.md, "Retired built-in
// providers"). Core has no SMS gateway, fraud checker or courier of its own:
// the Bangladesh ones are providers of the Bangladesh pack (`scalius.bangladesh`).
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
/** Its name, for the reason a retired choice gives until the app is active. */
export const BANGLADESH_PACK_NAME = "Bangladesh pack";

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

/** One retired built-in courier: a `delivery_providers` row of its type kept its setup as JSON. */
export interface RetiredCourier extends RetiredProvider {
  label: string;
  /** Its public tracking page before the move, with `{trackingId}`: kept for shipments booked then. */
  trackingUrl: string;
  /** The row's credential fields (decrypted JSON) → the app's setting key. */
  credentials: Readonly<Record<string, string>>;
  /** The row's config fields (JSON) → the app's setting key. */
  config: Readonly<Record<string, string>>;
}

const courier = (entry: Omit<RetiredCourier, "settings">): RetiredCourier => ({
  ...entry,
  settings: { ...entry.credentials, ...entry.config },
});

/**
 * Retired built-in couriers, by their old `delivery_providers.type` (also
 * `delivery_shipments.provider_type`). A row's webhook secret fell back to
 * Steadfast's API secret key; the pack keeps that rule.
 */
export const RETIRED_COURIER_PROVIDERS: Readonly<Record<string, RetiredCourier>> = {
  pathao: courier({
    replacement: pack("pathao"),
    label: "Pathao",
    trackingUrl: "https://merchant.pathao.com/tracking?consignment_id={trackingId}",
    credentials: {
      baseUrl: "pathao_base_url",
      clientId: "pathao_client_id",
      clientSecret: "pathao_client_secret",
      username: "pathao_username",
      password: "pathao_password",
      webhookSecret: "pathao_webhook_secret",
    },
    config: {
      storeId: "pathao_store_id",
      defaultDeliveryType: "pathao_delivery_type",
      defaultItemType: "pathao_item_type",
      defaultItemWeight: "pathao_item_weight",
    },
  }),
  steadfast: courier({
    replacement: pack("steadfast"),
    label: "Steadfast",
    trackingUrl: "https://steadfast.com.bd/t/{trackingId}",
    credentials: {
      baseUrl: "steadfast_base_url",
      apiKey: "steadfast_api_key",
      secretKey: "steadfast_secret_key",
      webhookSecret: "steadfast_webhook_secret",
    },
    config: {},
  }),
};

/**
 * The public tracking page of a parcel a retired courier booked before the
 * move (its shipment has no saved page), or null.
 */
export function retiredCourierTrackingUrl(providerType: string | null | undefined, trackingId: string | null | undefined): string | null {
  if (!providerType || !trackingId || !Object.hasOwn(RETIRED_COURIER_PROVIDERS, providerType)) return null;
  return RETIRED_COURIER_PROVIDERS[providerType]!.trackingUrl.split("{trackingId}").join(encodeURIComponent(trackingId));
}

/** The app provider a retired built-in id now means, or null when the id is not a retired one. */
export function retiredProviderReplacement(kind: "sms" | "fraud" | "courier", id: string | null | undefined): string | null {
  if (kind === "courier") return id && Object.hasOwn(RETIRED_COURIER_PROVIDERS, id) ? RETIRED_COURIER_PROVIDERS[id]!.replacement : null;
  const table = kind === "sms" ? RETIRED_SMS_PROVIDERS : RETIRED_FRAUD_PROVIDERS;
  const key = kind === "fraud" ? (id || "default") : id;
  return key && Object.hasOwn(table, key) ? table[key]!.replacement : null;
}
