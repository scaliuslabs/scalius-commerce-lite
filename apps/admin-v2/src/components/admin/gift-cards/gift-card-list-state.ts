// The Gift cards list's shareable state. The status tab may sit in the page
// URL; the search never does (it can be a customer's phone or email), and a
// pasted code is cut to its last 4 before it is kept or sent anywhere.

import { GIFT_CARD_PAGE_SIZE, type GiftCardListQuery } from "~/lib/api-query-options/gift-cards";

export const GIFT_CARD_TABS = ["all", "active", "disabled", "expired", "empty"] as const;
export type GiftCardTab = (typeof GIFT_CARD_TABS)[number];

export interface GiftCardListSearch {
  status?: Exclude<GiftCardTab, "all">;
}

export function validateGiftCardListSearch(search: Record<string, unknown>): GiftCardListSearch {
  const status = GIFT_CARD_TABS.find((tab): tab is Exclude<GiftCardTab, "all"> => tab !== "all" && tab === search.status);
  return status ? { status } : {};
}

/** Looks like a whole gift-card code (16 characters once dashes and spaces are gone). */
const WHOLE_CODE = /^[0-9A-Z]{16}$/i;

/**
 * The list search as it may be kept (this tab's session) and sent (`q`): a
 * whole code becomes its last 4, because codes are bearer value and never
 * travel in a query string. Anything else stays as typed (last 4 or a customer).
 */
export function giftCardSearchTerm(raw: string): string {
  const compact = raw.replace(/[\s-]/g, "");
  return WHOLE_CODE.test(compact) ? compact.slice(-4).toUpperCase() : raw;
}

/** The list's API query: `q` is the session search (last 4 or a customer), never a page URL param. */
export function giftCardListQuery(tab: GiftCardTab, term: string, cursor: string): GiftCardListQuery {
  return {
    limit: GIFT_CARD_PAGE_SIZE,
    ...(tab !== "all" ? { status: tab } : {}),
    ...(term ? { q: term } : {}),
    ...(cursor ? { cursor } : {}),
  };
}
