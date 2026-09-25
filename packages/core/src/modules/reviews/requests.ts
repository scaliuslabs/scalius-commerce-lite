import type { Database } from "@scalius/database/client";

/**
 * The 15-minute sweep that turns due `order_review_requests` rows into
 * `review_request` outbox rows (design §2.3).
 * Stub until B1 fills it: no I/O, nothing queued.
 */
export async function sweepReviewRequests(
  _db: Database,
  _options?: { now?: number; limit?: number },
): Promise<{ queued: number; skipped: number }> {
  return { queued: 0, skipped: 0 };
}

/**
 * Whether any published review changed since the given time, so the cron can
 * bump the cache generation once for coalesced buyer auto-publishes (design §2.5).
 * Stub until B1 fills it: no I/O, always false (never bumps).
 */
export async function reviewsChangedSince(
  _db: Database,
  _sinceEpochSeconds: number,
): Promise<boolean> {
  return false;
}
