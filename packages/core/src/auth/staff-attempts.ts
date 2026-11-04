import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { rateLimit } from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/hash";

/**
 * Failed staff proofs counted in the database, the store's one authority.
 * Workers Rate Limiting counts per Cloudflare location, so a native budget of
 * 5 a minute is 5 a minute in every location; these windows hold across the
 * whole edge. They live in Better Auth's own `rate_limit` table under a
 * `scalius:` key Better Auth never reads. Rows are bounded by the staff count:
 * a sign-in failure is counted only for an email that belongs to staff.
 */
export interface StaffFailurePolicy {
  readonly scope: string;
  readonly maxFailures: number;
  readonly windowMs: number;
}

/** Wrong passwords or codes inside a staff session: ten per fifteen minutes, as Better Auth's 2FA lockout. */
export const STAFF_PROOF_FAILURES: StaffFailurePolicy = { scope: "staff-proof", maxFailures: 10, windowMs: 15 * 60_000 };
/** Wrong sign-in passwords for one staff account from browsers it has never signed in on. */
export const STAFF_SIGN_IN_FAILURES: StaffFailurePolicy = { scope: "staff-sign-in", maxFailures: 20, windowMs: 15 * 60_000 };

async function failureKey(policy: StaffFailurePolicy, subject: string): Promise<string> {
  return `scalius:${policy.scope}:${await sha256Hex(`${policy.scope}\0${subject}`)}`;
}

/** Seconds until the window reopens when the subject's failures are used up, else null. */
export async function staffFailuresExhausted(
  db: Database,
  policy: StaffFailurePolicy,
  subject: string,
  nowMs = Date.now(),
): Promise<number | null> {
  const row = await db
    .select({ count: rateLimit.count, startedAt: rateLimit.lastRequest })
    .from(rateLimit)
    .where(eq(rateLimit.key, await failureKey(policy, subject)))
    .get();
  if (!row || row.count < policy.maxFailures || row.startedAt <= nowMs - policy.windowMs) return null;
  return Math.max(1, Math.ceil((row.startedAt + policy.windowMs - nowMs) / 1000));
}

/** Counts one failed proof of the subject in its current window (a lapsed window starts again at one). */
export async function recordStaffFailure(
  db: Database,
  policy: StaffFailurePolicy,
  subject: string,
  nowMs = Date.now(),
): Promise<void> {
  const key = await failureKey(policy, subject);
  const inserted = await db
    .insert(rateLimit)
    .values({ id: key, key, count: 1, lastRequest: nowMs })
    .onConflictDoNothing()
    .returning({ key: rateLimit.key });
  if (inserted[0]) return;
  const restarted = await db
    .update(rateLimit)
    .set({ count: 1, lastRequest: nowMs })
    .where(and(eq(rateLimit.key, key), lte(rateLimit.lastRequest, nowMs - policy.windowMs)))
    .returning({ key: rateLimit.key });
  if (restarted[0]) return;
  await db
    .update(rateLimit)
    .set({ count: sql`${rateLimit.count} + 1` })
    .where(and(eq(rateLimit.key, key), gt(rateLimit.lastRequest, nowMs - policy.windowMs)));
}
