import type { settingsSearchMessages } from "~/i18n/settings-search";
import { SETTINGS_NAV, type SettingsNavKey } from "./settings-nav";

/**
 * Settings pages whose parts serve different jobs are split, as Shopify's
 * Notifications is: the page lists its parts as rows, each with its state,
 * and each part is its own page with its own save bar and a back link
 * (audit/settings-ux/NAVIGATION-DECISION.md). Labels come from
 * `settingsSubPageMessages` (`~/i18n/settings-sub-pages`, loaded by the settings pages only) under the same `key`; the cards each part holds
 * are `SETTINGS_CARDS` entries with that `subPage`.
 */
const SUB_PAGES = [
  { page: "integrations", key: "tracking", slug: "tracking" },
  { page: "integrations", key: "orderTools", slug: "order-tools" },
  { page: "integrations", key: "aiApps", slug: "ai" },
  { page: "notifications", key: "customerMessages", slug: "customers" },
  { page: "notifications", key: "staffAlerts", slug: "staff" },
  { page: "notifications", key: "sending", slug: "sending" },
] as const;

export type SettingsSubPageKey = (typeof SUB_PAGES)[number]["key"];

/** One part: its page, its label key, its `part` in the page's address, and that page's path. */
export interface SettingsSubPage {
  page: SettingsNavKey;
  key: SettingsSubPageKey;
  slug: string;
  /** The split page's path; the part is `search` (`?part=`). */
  to: string;
  search: { part: string };
}

export const SETTINGS_SUB_PAGES: readonly SettingsSubPage[] = SUB_PAGES.map((entry) => ({
  ...entry,
  to: SETTINGS_NAV.find((item) => item.key === entry.page)!.to,
  search: { part: entry.slug },
}));

export function settingsSubPage(key: SettingsSubPageKey): SettingsSubPage {
  return SETTINGS_SUB_PAGES.find((entry) => entry.key === key)!;
}

/** The part of a split page its `?part=` names, if any. */
export function settingsPartOf(page: SettingsNavKey, slug: string | undefined): SettingsSubPage | undefined {
  return SETTINGS_SUB_PAGES.find((entry) => entry.page === page && entry.slug === slug);
}


/**
 * Every settings card, in page order. `card` is the card's DOM id (pass it as
 * `SettingsCard id`) and its name in `settingsSearchMessages`. A card on a
 * split page names its `subPage` (`SETTINGS_SUB_PAGES`); `anchors` are the
 * hash prefixes of its dialogs and rows (`#sending-sms`), so an old link to
 * the page still lands on the sub-page that holds them.
 */
export const SETTINGS_CARDS = [
  { page: "store", card: "business" },
  { page: "store", card: "webAddresses" },
  { page: "store", card: "storeDefaults" },
  { page: "users", card: "staff" },
  { page: "users", card: "roles" },
  { page: "policies", card: "storePolicies" },
  { page: "policies", card: "returnPolicy" },
  { page: "policies", card: "warrantyPolicies" },
  { page: "payments", card: "paymentMethods" },
  { page: "payments", card: "emiPlans" },
  { page: "payments", card: "payoutApps" },
  { page: "checkout", card: "customerContact" },
  { page: "checkout", card: "checkoutText" },
  { page: "checkout", card: "customerRequests" },
  { page: "checkout", card: "digitalDelivery" },
  { page: "checkout", card: "addressAutocomplete" },
  { page: "shipping", card: "deliveryCharges" },
  { page: "shipping", card: "localPickup" },
  { page: "shipping", card: "shippingProfiles" },
  { page: "shipping", card: "deliveryAreas" },
  { page: "shipping", card: "couriers" },
  { page: "taxes", card: "taxCollection" },
  { page: "taxes", card: "taxGroups" },
  { page: "taxes", card: "taxRegions" },
  { page: "taxes", card: "taxOverrides" },
  { page: "locations", card: "inventoryLocations" },
  { page: "markets", card: "markets" },
  { page: "markets", card: "exchangeRates" },
  { page: "salesChannels", card: "salesChannels" },
  { page: "languages", card: "languages" },
  { page: "languages", card: "machineTranslation" },
  { page: "customerAccounts", card: "customerFields" },
  { page: "customerAccounts", card: "customerSignIn" },
  { page: "customerAccounts", card: "otherSignIn" },
  { page: "customerAccounts", card: "marketingConsent" },
  { page: "privacy", card: "cookieBanner" },
  { page: "privacy", card: "customerData" },
  { page: "notifications", card: "customerNotifications", subPage: "customerMessages", anchors: ["customer-rule-"] },
  { page: "notifications", card: "browserNotifications", subPage: "customerMessages" },
  { page: "notifications", card: "staffNotifications", subPage: "staffAlerts", anchors: ["staff-email-"] },
  { page: "notifications", card: "sending", subPage: "sending", anchors: ["sending-"] },
  { page: "notifications", card: "chatApps", subPage: "sending" },
  { page: "webhooks", card: "webhooks" },
  { page: "customData", card: "customData" },
  { page: "integrations", card: "google", subPage: "tracking", anchors: ["google-"] },
  { page: "integrations", card: "facebook", subPage: "tracking", anchors: ["facebook-"] },
  { page: "integrations", card: "tiktok", subPage: "tracking", anchors: ["tiktok-"] },
  { page: "integrations", card: "tracking", subPage: "tracking" },
  { page: "integrations", card: "fraudCheck", subPage: "orderTools" },
  { page: "integrations", card: "scanner", subPage: "orderTools" },
  { page: "integrations", card: "aiAccess", subPage: "aiApps" },
  { page: "integrations", card: "aiDrafting", subPage: "aiApps" },
  { page: "integrations", card: "appSearch", subPage: "aiApps" },
  { page: "importExport", card: "imports" },
  { page: "importExport", card: "exports" },
  { page: "advanced", card: "trustedWebsites" },
  { page: "advanced", card: "imageDelivery" },
  { page: "advanced", card: "signInAccess" },
  { page: "advanced", card: "refreshStore" },
] as const satisfies ReadonlyArray<{
  page: SettingsNavKey;
  card: keyof typeof settingsSearchMessages.en;
  subPage?: SettingsSubPageKey;
  anchors?: readonly string[];
}>;

export type SettingsCardEntry = (typeof SETTINGS_CARDS)[number];
export type SettingsCardId = SettingsCardEntry["card"];

type CardLocation = { page: SettingsNavKey; card: string; subPage?: SettingsSubPageKey; anchors?: readonly string[] };
const CARDS: readonly CardLocation[] = SETTINGS_CARDS;

/** Where a card is: its page, and the part (`?part=`) that holds it on a split page. */
export interface SettingsCardLink {
  to: string;
  search?: { part: string };
}

export function settingsCardLink(entry: { page: SettingsNavKey; card: string }): SettingsCardLink {
  const subPage = CARDS.find((item) => item.card === entry.card)?.subPage;
  if (!subPage) return { to: SETTINGS_NAV.find((item) => item.key === entry.page)!.to };
  const { to, search } = settingsSubPage(subPage);
  return { to, search };
}

/**
 * The sub-page of a split page that holds the card or dialog a hash names
 * (`#sending-sms`, `#facebook`), for links written before the page was split.
 */
export function subPageForHash(page: SettingsNavKey, hash: string): SettingsSubPage | undefined {
  if (!hash) return undefined;
  const entry = CARDS.find((item) => item.page === page && item.subPage
    && (item.card === hash || item.anchors?.some((prefix) => hash.startsWith(prefix))));
  return entry?.subPage ? SETTINGS_SUB_PAGES.find((item) => item.key === entry.subPage) : undefined;
}

