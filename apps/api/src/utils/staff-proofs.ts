import { verifyPendingTotpCode, type Auth } from "@scalius/core/auth";
import { STAFF_PROOF_ATTEMPTS, reserveStaffAttempt, type StaffAttempt } from "@scalius/core/auth/staff-attempts";
import type { Database } from "@scalius/database/client";
import { RateLimitError } from "./api-error";
import { isWithinRateLimit } from "./rate-limit";

/**
 * Every password or second-factor proof a staff member makes inside a session
 * (change password, confirm a 2FA change, turn 2FA off, set 2FA up, verify a
 * pending session) is bounded per person twice: the native strict limiter
 * (5 a minute, a cheap first gate, but counted per Cloudflare location) and an
 * attempt reserved in the database before the proof runs (10 per 15 minutes
 * across the whole edge; a right answer gives it back). Better Auth limits only
 * its own router, by IP, and its session path counts no failed codes, so a
 * stolen session could otherwise guess a password or a 6-digit code without end.
 *
 * This module is the only caller of those Better Auth proofs in the API.
 */
export const STAFF_PROOF_LIMIT_PURPOSE = "staff-proof";
const STAFF_PROOF_RETRY_AFTER_SECONDS = 60;

/**
 * Spends one proof attempt of this staff member and reserves it in the
 * database; throws 429 while either budget is used up. The caller refunds the
 * reservation after a right answer.
 */
export async function reserveStaffProof(env: Env, db: Database, userId: string): Promise<StaffAttempt> {
  if (!(await isWithinRateLimit(env, "RL_STRICT", STAFF_PROOF_LIMIT_PURPOSE, userId))) {
    throw new RateLimitError("Too many attempts. Wait a minute and try again.", STAFF_PROOF_RETRY_AFTER_SECONDS);
  }
  const attempt = await reserveStaffAttempt(db, STAFF_PROOF_ATTEMPTS, userId);
  if (attempt.waitSeconds !== null) {
    throw new RateLimitError("Too many wrong attempts. Wait and try again.", attempt.waitSeconds);
  }
  return attempt;
}

function counted<T extends (...args: never[]) => Promise<unknown>>(
  proof: T,
  attempt: StaffAttempt,
  refused?: (answer: unknown) => boolean,
): T {
  return (async (...args: Parameters<T>) => {
    const answer = await proof(...args);
    if (!refused?.(answer)) await attempt.refund();
    return answer;
  }) as T;
}

/**
 * Better Auth's in-session proofs for one staff member, handed out only after
 * one attempt of that person's budget is reserved; a right answer gives it
 * back, a wrong one (or none) keeps it. A request takes them once, before any
 * try/catch that maps a failed proof to "wrong password", so a 429 is never
 * reported as a wrong guess.
 */
export async function staffProofs(env: Env, db: Database, auth: Auth, userId: string) {
  const attempt = await reserveStaffProof(env, db, userId);
  return {
    verifyPassword: counted(auth.api.verifyPassword, attempt, (answer) => (answer as { status?: unknown } | null)?.status !== true),
    changePassword: counted(auth.api.changePassword, attempt),
    verifyTOTP: counted(auth.api.verifyTOTP, attempt),
    verifyTwoFactorOTP: counted(auth.api.verifyTwoFactorOTP, attempt),
    verifyBackupCode: counted(auth.api.verifyBackupCode, attempt),
    enableTwoFactor: counted(auth.api.enableTwoFactor, attempt),
    // The new authenticator's first code, checked against the method change's pending key.
    verifyPendingTotpCode: counted(verifyPendingTotpCode, attempt, (answer) => answer !== true),
  };
}

export type StaffProofs = Awaited<ReturnType<typeof staffProofs>>;
