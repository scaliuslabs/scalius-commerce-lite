// The account navigation: Orders, Profile and Inbox always; Reviews whenever
// the store shows reviews and Downloads whenever it sells digital items (so
// the strip is the same on every account page, Shopify-style), and Gift
// cards and Warranties (active ones) while the account has something there
// (or the buyer is on that page). One server read, GET /customer-auth/account-summary,
// gives every count, so every account page renders the same strip and nothing
// shifts between pages. Labels and badge digits are in the page's language.
import { accountCopy } from "./account-copy";
import { formatCount } from "./store-time-zone";

export interface AccountSummary {
  unreadInbox: number;
  reviewsToWrite: number;
  reviewsWritten: number;
  downloads: number;
  giftCards: number;
  activeWarranties: number;
}

const SUMMARY_KEYS = ["unreadInbox", "reviewsToWrite", "reviewsWritten", "downloads", "giftCards", "activeWarranties"] as const satisfies ReadonlyArray<keyof AccountSummary>;

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

/** Counts from the API; anything missing or malformed counts as zero. */
export function readAccountSummary(value: unknown): AccountSummary | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const summary = {} as AccountSummary;
  for (const key of SUMMARY_KEYS) {
    const count = raw[key];
    summary[key] = typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }
  return summary;
}
