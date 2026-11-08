// "Once" for events whose page can repeat: a search results page per query in
// a session, a payment per checkout attempt and method, a receipt per order.
// The emitting page claims the key first, so every listener (the store's tags,
// islands, pixels) hears the event once. Kept in this page's memory and in
// session storage; blocked storage still protects the page.

const STORAGE_KEY = "scalius_analytics_dedupe_v1";
const MAX_KEYS = 100;
const claimed = new Set<string>();

function persisted(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage?.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

/** True the first time `key` is claimed in this session; false after. */
export function claimOnce(key: string): boolean {
  if (typeof window === "undefined") return true;
  if (claimed.has(key)) return false;
  claimed.add(key);
  const keys = persisted();
  if (keys.includes(key)) return false;
  try {
    window.sessionStorage?.setItem(STORAGE_KEY, JSON.stringify([...keys, key].slice(-MAX_KEYS)));
  } catch {
    // Storage can be blocked: this page's memory still holds the claim.
  }
  return true;
}
