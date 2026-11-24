// The account navigation: Orders, Profile and Inbox always; Reviews whenever
// the store shows reviews and Downloads whenever it sells digital items (so
// the strip is the same on every account page, Shopify-style), and Gift
// cards and Warranties (active ones) while the account has something there
// (or the buyer is on that page). One server read, GET /customer-auth/account-summary,
// gives every count, so every account page renders the same strip and nothing
// shifts between pages. Labels and badge digits are in the page's language.
import { accountCopy } from "./account-copy";
import { formatMinorMoney } from "./currency";
import { formatCount } from "./store-time-zone";

/** What the account spent in one currency: its orders and what the store holds of them (minor units). */
export interface AccountSpend {
  currencyCode: string;
  orders: number;
  amountMinor: number;
}

export interface AccountSummary {
  /** Placed orders in any currency (not unfinished checkouts). */
  orders: number;
  /** One row per currency the account bought in; empty before the first order. */
  spent: AccountSpend[];
  /** Conversations that are not closed. */
  openConversations: number;
  unreadInbox: number;
  reviewsToWrite: number;
  reviewsWritten: number;
  downloads: number;
  giftCards: number;
  activeWarranties: number;
}

const SUMMARY_KEYS = ["orders", "openConversations", "unreadInbox", "reviewsToWrite", "reviewsWritten", "downloads", "giftCards", "activeWarranties"] as const satisfies ReadonlyArray<keyof AccountSummary>;

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

export type AccountSection = "orders" | "profile" | "inbox" | "reviews" | "downloads" | "gift-cards" | "warranties";

export interface AccountNavTab {
  key: AccountSection;
  href: string;
  label: string;
  /** A count worth the buyer's attention ("3"), or "" for none. */
  badge: string;
  badgeLabel: string;
}

function badgeText(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "";
  return count > 99 ? `${formatCount(99)}+` : formatCount(Math.floor(count));
}

/** What the store offers: a section it offers is always in the strip. */
export interface AccountStoreFacts {
  /** Reviews are on and the store has a published review. */
  hasReviews: boolean;
  /** The store sells a digital line. */
  hasDigitalLines: boolean;
}

/** The tabs in their fixed order for this page. */
export function accountNavTabs(
  current: AccountSection,
  summary: AccountSummary | null,
  store: AccountStoreFacts = { hasReviews: false, hasDigitalLines: false },
): AccountNavTab[] {
  const has = (key: AccountSection, count: number) => key === current || count > 0;
  const words = accountCopy().shell;
  const tabs: Array<AccountNavTab & { show: boolean }> = [
    { key: "orders", href: "/account", label: words.orders, badge: "", badgeLabel: "", show: true },
    { key: "profile", href: "/account/profile", label: words.profile, badge: "", badgeLabel: "", show: true },
    { key: "inbox", href: "/account/inbox", label: words.inbox, badge: badgeText(summary?.unreadInbox ?? 0), badgeLabel: words.unread, show: true },
    {
      key: "reviews",
      href: "/account/reviews",
      label: words.reviews,
      badge: badgeText(summary?.reviewsToWrite ?? 0),
      badgeLabel: words.toReview,
      show: store.hasReviews || has("reviews", (summary?.reviewsToWrite ?? 0) + (summary?.reviewsWritten ?? 0)),
    },
    { key: "downloads", href: "/account/downloads", label: words.downloads, badge: "", badgeLabel: "", show: store.hasDigitalLines || has("downloads", summary?.downloads ?? 0) },
    { key: "gift-cards", href: "/account/gift-cards", label: words.giftCards, badge: "", badgeLabel: "", show: has("gift-cards", summary?.giftCards ?? 0) },
    { key: "warranties", href: "/account/warranties", label: words.warranties, badge: "", badgeLabel: "", show: has("warranties", summary?.activeWarranties ?? 0) },
  ];
  return tabs.filter((tab) => tab.show).map(({ show: _show, ...tab }) => tab);
}

/** Counts from the API; anything missing or malformed counts as zero, and a malformed spend row is left out. */
export function readAccountSummary(value: unknown): AccountSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const summary = { spent: [] as AccountSpend[] } as AccountSummary;
  for (const key of SUMMARY_KEYS) summary[key] = count(raw[key]);
  summary.spent = (Array.isArray(raw.spent) ? raw.spent : []).flatMap((row) => {
    const each = row as Partial<AccountSpend> | null;
    return each && typeof each.currencyCode === "string" && /^[A-Z]{3}$/.test(each.currencyCode)
      ? [{ currencyCode: each.currencyCode, orders: count(each.orders), amountMinor: count(each.amountMinor) }]
      : [];
  });
  return summary;
}

/** One figure of the account summary: its label, its value(s) in the page's digits, and where its list is. */
export interface AccountSummaryStat {
  key: "orders" | "spent" | "conversations";
  label: string;
  /** One line per value: the spend is one line per currency. */
  values: string[];
  /** A secondary line ("2 unread"), or "". */
  note: string;
  href: string;
}

/**
 * The account's numbers over its orders, each a link to its list: orders and
 * spend to the list below (`ordersHref`), open conversations to the Inbox.
 * Null while there is nothing to sum up (no order, no open conversation) or
 * the summary is unknown. A spend before any payment reads zero in the store's currency.
 */
export function accountSummaryStats(
  summary: AccountSummary | null,
  options: { storeCurrency: string; ordersHref: string },
): AccountSummaryStat[] | null {
  if (!summary || (summary.orders === 0 && summary.openConversations === 0)) return null;
  const words = accountCopy().orders;
  const spent = summary.spent.length > 0
    ? summary.spent.map((row) => formatMinorMoney({ amountMinor: row.amountMinor, currency: row.currencyCode }))
    : [formatMinorMoney({ amountMinor: 0, currency: options.storeCurrency })];
  return [
    { key: "orders", label: words.statOrders, values: [formatCount(summary.orders)], note: "", href: options.ordersHref },
    {
      key: "conversations",
      label: words.statConversations,
      values: [formatCount(summary.openConversations)],
      note: summary.unreadInbox > 0 ? words.statUnread(formatCount(summary.unreadInbox)) : "",
      href: "/account/inbox",
    },
    { key: "spent", label: words.statSpent, values: spent, note: "", href: options.ordersHref },
  ];
}
