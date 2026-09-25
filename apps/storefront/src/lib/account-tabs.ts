// The account navigation: Orders, Profile and Inbox always, then Reviews,
// Downloads and Gift cards while the account has something there (or the
// buyer is on that page). One server read, GET /customer-auth/account-summary,
// gives every count, so every account page renders the same strip and nothing
// shifts between pages.

export interface AccountSummary {
  unreadInbox: number;
  reviewsToWrite: number;
  reviewsWritten: number;
  downloads: number;
  giftCards: number;
  activeWarranties: number;
}

const SUMMARY_KEYS = ["unreadInbox", "reviewsToWrite", "reviewsWritten", "downloads", "giftCards", "activeWarranties"] as const satisfies ReadonlyArray<keyof AccountSummary>;

export type AccountSection = "orders" | "profile" | "inbox" | "reviews" | "downloads" | "gift-cards";

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
  return count > 99 ? "99+" : String(Math.floor(count));
}

/** The tabs in their fixed order for this page. */
export function accountNavTabs(current: AccountSection, summary: AccountSummary | null): AccountNavTab[] {
  const has = (key: AccountSection, count: number) => key === current || count > 0;
  const tabs: Array<AccountNavTab & { show: boolean }> = [
    { key: "orders", href: "/account", label: "Orders", badge: "", badgeLabel: "", show: true },
    { key: "profile", href: "/account/profile", label: "Profile", badge: "", badgeLabel: "", show: true },
    { key: "inbox", href: "/account/inbox", label: "Inbox", badge: badgeText(summary?.unreadInbox ?? 0), badgeLabel: "unread", show: true },
    {
      key: "reviews",
      href: "/account/reviews",
      label: "Reviews",
      badge: badgeText(summary?.reviewsToWrite ?? 0),
      badgeLabel: "to review",
      show: has("reviews", (summary?.reviewsToWrite ?? 0) + (summary?.reviewsWritten ?? 0)),
    },
    { key: "downloads", href: "/account/downloads", label: "Downloads", badge: "", badgeLabel: "", show: has("downloads", summary?.downloads ?? 0) },
    { key: "gift-cards", href: "/account/gift-cards", label: "Gift cards", badge: "", badgeLabel: "", show: has("gift-cards", summary?.giftCards ?? 0) },
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
