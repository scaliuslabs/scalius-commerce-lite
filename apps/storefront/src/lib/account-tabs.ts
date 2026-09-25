// The account tabs: Orders and Inbox always, then Reviews, Downloads, Gift
// cards and Warranties, each only while its count is above zero (zero states
// are silent). One read, GET /customer-auth/account-summary, gives every count
// including the Inbox badge's. The tab pages belong to their features:
// /account/reviews (B2), /account/downloads (B3), /account/gift-cards (B4),
// /account/warranties (B5).

export interface AccountSummary {
  unreadInbox: number;
  reviewsToWrite: number;
  downloads: number;
  giftCards: number;
  activeWarranties: number;
}

const SUMMARY_KEYS = ["unreadInbox", "reviewsToWrite", "downloads", "giftCards", "activeWarranties"] as const satisfies ReadonlyArray<keyof AccountSummary>;

export const ACCOUNT_FEATURE_TABS = [
  { href: "/account/reviews", label: "Reviews", count: "reviewsToWrite" },
  { href: "/account/downloads", label: "Downloads", count: "downloads" },
  { href: "/account/gift-cards", label: "Gift cards", count: "giftCards" },
  { href: "/account/warranties", label: "Warranties", count: "activeWarranties" },
] as const satisfies ReadonlyArray<{ href: string; label: string; count: keyof AccountSummary }>;

export type AccountFeatureTab = (typeof ACCOUNT_FEATURE_TABS)[number];

/** The feature tabs to show; none while the summary is unknown. */
export function visibleAccountFeatureTabs(summary: AccountSummary | null | undefined): AccountFeatureTab[] {
  return summary ? ACCOUNT_FEATURE_TABS.filter((tab) => summary[tab.count] > 0) : [];
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

/** The signed-in account's summary; null when unknown (signed out, offline, error). Same-origin proxy, session cookie. */
export async function fetchAccountSummary(fetcher: typeof fetch = fetch): Promise<AccountSummary | null> {
  try {
    const response = await fetcher("/api/customer-auth/account-summary", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = await response.json() as { success?: boolean; data?: unknown };
    return payload?.success ? readAccountSummary(payload.data) : null;
  } catch {
    return null;
  }
}
