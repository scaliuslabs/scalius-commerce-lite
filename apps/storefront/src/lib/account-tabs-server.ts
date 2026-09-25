// The account tab counts for server-rendered account pages (Inbox, Downloads,
// and later Reviews, Gift cards, Warranties): one GET /customer-auth/account-
// summary with the session cookie only. Null when signed out or unreachable;
// the tabs then show only what always shows.
import { resolveBackendTarget } from "@/lib/api/transport";
import { sessionCookieOf } from "@/lib/account-inbox-server";
import { readAccountSummary, type AccountSummary } from "@/lib/account-tabs";

const SUMMARY_TIMEOUT_MS = 4_000;

export async function readAccountSummaryForRequest(request: Request): Promise<AccountSummary | null> {
  const session = sessionCookieOf(request);
  if (!session) return null;
  const target = resolveBackendTarget("/api/v1/customer-auth/account-summary");
  if (!target) return null;
  try {
    const response = await target.fetch(target.url, {
      method: "GET",
      headers: { Accept: "application/json", Cookie: session },
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const payload = await response.json().catch(() => null) as { success?: unknown; data?: unknown } | null;
    return payload?.success === true ? readAccountSummary(payload.data) : null;
  } catch {
    return null;
  }
}
