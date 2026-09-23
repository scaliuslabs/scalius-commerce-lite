import { settingsNavMessages, settingsSummaryMessages } from "~/i18n/settings";
import { settingsSearchMessages } from "~/i18n/settings-search";
import { SETTINGS_NAV, type SettingsNavKey } from "./settings-nav";

/**
 * Every settings card, in list order. `card` is the card's DOM id (pass it as
 * `SettingsCard id`) and its name in `settingsSearchMessages`.
 */
export const SETTINGS_CARDS = [
  { page: "store", card: "business" },
  { page: "store", card: "webAddresses" },
  { page: "store", card: "storeDefaults" },
  { page: "users", card: "staff" },
  { page: "users", card: "roles" },
  { page: "policies", card: "returnPolicy" },
  { page: "payments", card: "paymentMethods" },
  { page: "payments", card: "paymentOptions" },
  { page: "checkout", card: "customerContact" },
  { page: "checkout", card: "checkoutText" },
  { page: "checkout", card: "customerRequests" },
  { page: "shipping", card: "deliveryCharges" },
  { page: "shipping", card: "deliveryAreas" },
  { page: "shipping", card: "couriers" },
  { page: "taxes", card: "taxCollection" },
  { page: "taxes", card: "taxGroups" },
  { page: "taxes", card: "taxRates" },
  { page: "taxes", card: "taxOverrides" },
  { page: "customerAccounts", card: "customerSignIn" },
  { page: "notifications", card: "customerNotifications" },
  { page: "notifications", card: "staffNotifications" },
  { page: "notifications", card: "sending" },
  { page: "apps", card: "tracking" },
  { page: "apps", card: "facebook" },
  { page: "apps", card: "fraudCheck" },
  { page: "apps", card: "aiAccess" },
  { page: "apps", card: "scanner" },
  { page: "advanced", card: "trustedWebsites" },
  { page: "advanced", card: "imageDelivery" },
  { page: "advanced", card: "signInAccess" },
  { page: "advanced", card: "refreshStore" },
] as const satisfies ReadonlyArray<{ page: SettingsNavKey; card: keyof typeof settingsSearchMessages.en }>;

export type SettingsCardId = (typeof SETTINGS_CARDS)[number]["card"];

function words(text: string): string[] {
  return text.normalize("NFC").toLocaleLowerCase().split(/[\s,.&/·()-]+/).filter(Boolean);
}

function haystack(...texts: string[]): string[] {
  return texts.flatMap(words);
}

/** Every query word must start one of the entry's words, in either language. */
function matches(query: string[], entry: string[]): boolean {
  return query.every((term) => entry.some((word) => word.startsWith(term)));
}

const PAGE_WORDS = new Map(
  SETTINGS_NAV.map(({ key }) => [
    key,
    haystack(
      settingsNavMessages.en[key],
      settingsNavMessages.bn[key],
      settingsSummaryMessages.en[key],
      settingsSummaryMessages.bn[key],
    ),
  ]),
);

const CARD_WORDS = new Map(
  SETTINGS_CARDS.map(({ card }) => [
    card,
    haystack(
      settingsSearchMessages.en[card],
      settingsSearchMessages.bn[card],
      settingsSearchMessages.en[`${card}Terms`],
      settingsSearchMessages.bn[`${card}Terms`],
    ),
  ]),
);

/** Pages and cards matching a settings search, in list order. */
export function searchSettings(query: string): {
  pages: SettingsNavKey[];
  cards: Array<(typeof SETTINGS_CARDS)[number]>;
} {
  const terms = words(query);
  if (terms.length === 0) return { pages: SETTINGS_NAV.map((item) => item.key), cards: [] };
  return {
    pages: SETTINGS_NAV.filter(({ key }) => matches(terms, PAGE_WORDS.get(key)!)).map((item) => item.key),
    cards: SETTINGS_CARDS.filter(({ card }) => matches(terms, CARD_WORDS.get(card)!)),
  };
}
