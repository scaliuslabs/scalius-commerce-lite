import { and, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { rateLimit } from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/hash";
import { sweepExpiredRows } from "../utils/sweep-expired-rows";

/**
 * Staff password and code attempts counted in the database, the store's one
 * authority. Workers Rate Limiting counts per Cloudflare location, so a native
 * budget of 5 a minute is 5 a minute in every location; these windows hold
 * across the whole edge. They live in Better Auth's own `rate_limit` table
 * under `scalius:` keys Better Auth never reads.
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

/** One reserved attempt: refused (with the honest wait) or held until `refund`. */
export interface StaffAttempt {
  readonly waitSeconds: number | null;
  /** Gives the attempt back after a right answer (in its own window only). */
  refund(): Promise<void>;
}

async function attemptKey(policy: StaffAttemptPolicy, subject: string): Promise<string> {
  return `scalius:${policy.scope}:${await sha256Hex(`${policy.scope}\0${subject}`)}`;
}

/**
 * Counts one attempt of the subject in its current window (a lapsed window
 * starts again at one) and answers with the count, atomically. Over the limit
 * the attempt is refused; it still counts, so a flood keeps the window shut.
 */
export async function reserveStaffAttempt(
  db: Database,
  policy: StaffAttemptPolicy,
  subject: string,
  nowMs = Date.now(),
): Promise<StaffAttempt> {
  const key = await attemptKey(policy, subject);
  const lapsedBefore = nowMs - policy.windowMs;
  const [row] = await db
    .insert(rateLimit)
    .values({ id: key, key, count: 1, lastRequest: nowMs })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`CASE WHEN ${rateLimit.lastRequest} <= ${lapsedBefore} THEN 1 ELSE ${rateLimit.count} + 1 END`,
        lastRequest: sql`CASE WHEN ${rateLimit.lastRequest} <= ${lapsedBefore} THEN ${nowMs} ELSE ${rateLimit.lastRequest} END`,
      },
    })
    .returning({ count: rateLimit.count, startedAt: rateLimit.lastRequest });
  const count = row?.count ?? 1;
  const startedAt = row?.startedAt ?? nowMs;
  const waitSeconds = count > policy.maxAttempts
    ? Math.max(1, Math.ceil((startedAt + policy.windowMs - nowMs) / 1000))
    : null;
  let refunded = false;
  return {
    waitSeconds,
    refund: async () => {
      if (refunded || waitSeconds !== null) return;
      refunded = true;
      await db
        .update(rateLimit)
        .set({ count: sql`CASE WHEN ${rateLimit.count} > 0 THEN ${rateLimit.count} - 1 ELSE 0 END` })
        .where(and(eq(rateLimit.key, key), eq(rateLimit.lastRequest, startedAt)));
    },
  };
}

export interface SweepExpiredStaffAttemptsResult {
  scanned: number;
  deleted: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Deletes lapsed attempt windows in bounded batches. The `scalius:` keys are a
 * key range (`:` sorts just before `;`), so the sweep walks the unique key
 * index and never touches Better Auth's own rows.
 */
export async function sweepExpiredStaffAttempts(
  db: Database,
  nowMs = Date.now(),
  options: { limit?: number } = {},
): Promise<SweepExpiredStaffAttemptsResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  return sweepExpiredRows(
    db,
    rateLimit,
    rateLimit.id,
    and(gte(rateLimit.key, "scalius:"), lt(rateLimit.key, "scalius;"), lte(rateLimit.lastRequest, nowMs - WINDOW_MS)),
    limit,
  );
}

/** For tests and reports: the subject's live count in its window, 0 when none. */
export async function staffAttemptCount(db: Database, policy: StaffAttemptPolicy, subject: string, nowMs = Date.now()): Promise<number> {
  const row = await db
    .select({ count: rateLimit.count })
    .from(rateLimit)
    .where(and(eq(rateLimit.key, await attemptKey(policy, subject)), gt(rateLimit.lastRequest, nowMs - policy.windowMs)))
    .get();
  return row?.count ?? 0;
}
