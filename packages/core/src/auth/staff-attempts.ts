import { and, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { staffAuthAttempts as attempts } from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/hash";
import { sweepExpiredRows } from "../utils/sweep-expired-rows";

/**
 * Staff password and code attempts counted in the database, the store's one
 * authority. Workers Rate Limiting counts per Cloudflare location, so a native
 * budget of 5 a minute is 5 a minute in every location; these windows hold
 * across the whole edge. They live in their own table: Better Auth's database
 * limiter deletes every `rate_limit` row older than its longest window (five
 * minutes) whenever one of its windows resets, whatever the key, so a window
 * kept there would be wiped in the middle of an attack.
 *
 * An attempt is reserved before the proof runs, in one atomic upsert, so
 * parallel guesses cannot all pass a check made before any was counted; a
 * right answer gives its reservation back, so the budget counts wrong answers
 * and attempts still in flight.
 */
export interface StaffAttemptPolicy {
  readonly scope: string;
  readonly maxAttempts: number;
  readonly windowMs: number;
}

const WINDOW_MS = 15 * 60_000;
/** Wrong passwords or codes inside a staff session: ten per fifteen minutes, as Better Auth's 2FA lockout. */
export const STAFF_PROOF_ATTEMPTS: StaffAttemptPolicy = { scope: "staff-proof", maxAttempts: 10, windowMs: WINDOW_MS };
/** Wrong sign-in passwords for one email from browsers it never signed in on, any email alike. */
export const STAFF_SIGN_IN_ATTEMPTS: StaffAttemptPolicy = { scope: "staff-sign-in", maxAttempts: 20, windowMs: WINDOW_MS };
/**
 * Wrong sign-in passwords from one network address, whatever the account: a
 * ceiling far above one office's typing mistakes that slows a sprayer trying
 * one password on many accounts. Right passwords give their attempt back, so
 * staff signing in from one office never spend each other's budget.
 */
export const STAFF_SIGN_IN_NETWORK_ATTEMPTS: StaffAttemptPolicy = { scope: "staff-sign-in-network", maxAttempts: 100, windowMs: WINDOW_MS };
/** The sweep keeps every window until the longest one has lapsed (a shorter one is already refused nothing). */
const LONGEST_WINDOW_MS = Math.max(STAFF_PROOF_ATTEMPTS.windowMs, STAFF_SIGN_IN_ATTEMPTS.windowMs, STAFF_SIGN_IN_NETWORK_ATTEMPTS.windowMs);

/** One reserved attempt: refused (with the honest wait) or held until `refund`. */
export interface StaffAttempt {
  readonly waitSeconds: number | null;
  /** Gives the attempt back after a right answer (in its own window only). */
  refund(): Promise<void>;
}

async function attemptKey(policy: StaffAttemptPolicy, subject: string): Promise<string> {
  return `${policy.scope}:${await sha256Hex(`${policy.scope}\0${subject}`)}`;
}

/**
 * Counts one attempt of the subject in its current window (a lapsed window
 * starts again at one) and answers with the count, atomically. A window
 * already at its limit is not written at all: the attempt is refused and the
 * wait read separately. A missing answer never passes as an allowed attempt.
 */
export async function reserveStaffAttempt(
  db: Database,
  policy: StaffAttemptPolicy,
  subject: string,
  nowMs = Date.now(),
): Promise<StaffAttempt> {
  const key = await attemptKey(policy, subject);
  const lapsedBefore = nowMs - policy.windowMs;
  const lapsed = sql`${attempts.windowStartedAt} <= ${lapsedBefore}`;
  const [row] = await db
    .insert(attempts)
    .values({ key, attempts: 1, windowStartedAt: nowMs })
    .onConflictDoUpdate({
      target: attempts.key,
      set: {
        attempts: sql`CASE WHEN ${lapsed} THEN 1 ELSE ${attempts.attempts} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${lapsed} THEN ${nowMs} ELSE ${attempts.windowStartedAt} END`,
      },
      setWhere: or(lte(attempts.windowStartedAt, lapsedBefore), lt(attempts.attempts, policy.maxAttempts)),
    })
    .returning({ count: attempts.attempts, startedAt: attempts.windowStartedAt });
  if (!row) {
    const full = await db.select({ startedAt: attempts.windowStartedAt }).from(attempts).where(eq(attempts.key, key)).get();
    if (!full) throw new Error("A staff attempt could not be reserved.");
    return { waitSeconds: waitUntil(full.startedAt, policy, nowMs), refund: async () => {} };
  }
  if (row.count > policy.maxAttempts) {
    return { waitSeconds: waitUntil(row.startedAt, policy, nowMs), refund: async () => {} };
  }
  let refunded = false;
  return {
    waitSeconds: null,
    refund: async () => {
      if (refunded) return;
      refunded = true;
      await db
        .update(attempts)
        .set({ attempts: sql`CASE WHEN ${attempts.attempts} > 0 THEN ${attempts.attempts} - 1 ELSE 0 END` })
        .where(and(eq(attempts.key, key), eq(attempts.windowStartedAt, row.startedAt)));
    },
  };
}

function waitUntil(startedAt: number, policy: StaffAttemptPolicy, nowMs: number): number {
  return Math.max(1, Math.ceil((startedAt + policy.windowMs - nowMs) / 1000));
}

export interface SweepExpiredStaffAttemptsResult {
  scanned: number;
  deleted: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Deletes lapsed attempt windows in bounded batches: every row whose window
 * started before the longest window, by `staff_auth_attempts_window_idx`, so
 * live windows (an email spray leaves many) are never walked.
 */
export async function sweepExpiredStaffAttempts(
  db: Database,
  nowMs = Date.now(),
  options: { limit?: number } = {},
): Promise<SweepExpiredStaffAttemptsResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  return sweepExpiredRows(db, attempts, attempts.key, lte(attempts.windowStartedAt, nowMs - LONGEST_WINDOW_MS), limit);
}

/** For tests and reports: the subject's live count in its window, 0 when none. */
export async function staffAttemptCount(db: Database, policy: StaffAttemptPolicy, subject: string, nowMs = Date.now()): Promise<number> {
  const row = await db
    .select({ count: attempts.attempts })
    .from(attempts)
    .where(and(eq(attempts.key, await attemptKey(policy, subject)), gt(attempts.windowStartedAt, nowMs - policy.windowMs)))
    .get();
  return row?.count ?? 0;
}
