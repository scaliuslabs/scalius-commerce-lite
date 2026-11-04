import type { Auth } from "@scalius/core/auth";
import { STAFF_PROOF_FAILURES, recordStaffFailure, staffFailuresExhausted } from "@scalius/core/auth/staff-attempts";
import type { Database } from "@scalius/database/client";
import { RateLimitError } from "./api-error";
import { isWithinRateLimit } from "./rate-limit";

/**
 * Every password or second-factor proof a staff member makes inside a session
 * (change password, confirm a 2FA change, turn 2FA off, set 2FA up, verify a
 * pending session) is bounded per person twice: the native strict limiter
 * (5 a minute, a cheap first gate, but counted per Cloudflare location) and
 * the person's failed proofs in the database (10 per 15 minutes across the
 * whole edge). Better Auth limits only its own router, by IP, and its session
 * path counts no failed codes, so a stolen session could otherwise guess a
 * password or a 6-digit code without end.
 *
 * This module is the only caller of those Better Auth proofs in the API.
 */
export const STAFF_PROOF_LIMIT_PURPOSE = "staff-proof";
const STAFF_PROOF_RETRY_AFTER_SECONDS = 60;

/** Spends one proof attempt of this staff member; throws 429 while either budget is used up. */
export async function enforceStaffProofLimit(env: Env, db: Database, userId: string): Promise<void> {
  if (!(await isWithinRateLimit(env, "RL_STRICT", STAFF_PROOF_LIMIT_PURPOSE, userId))) {
    throw new RateLimitError("Too many attempts. Wait a minute and try again.", STAFF_PROOF_RETRY_AFTER_SECONDS);
  }
  const waitSeconds = await staffFailuresExhausted(db, STAFF_PROOF_FAILURES, userId);
  if (waitSeconds !== null) {
    throw new RateLimitError("Too many wrong attempts. Wait and try again.", waitSeconds);
  }
}

/** Counts one wrong password or code of this staff member. */
export function recordStaffProofFailure(db: Database, userId: string): Promise<void> {
  return recordStaffFailure(db, STAFF_PROOF_FAILURES, userId);
}

/** A Better Auth answer that refused the proof itself (wrong password or code), not the request. */
export function isRejectedProof(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

function counted<T extends (...args: never[]) => Promise<unknown>>(proof: T, fail: () => Promise<void>, refused?: (answer: unknown) => boolean): T {
  return (async (...args: Parameters<T>) => {
    let answer: unknown;
    try {
      answer = await proof(...args);
    } catch (error) {
      if (isRejectedProof(error)) await fail();
      throw error;
    }
    if (refused?.(answer)) await fail();
    return answer;
  }) as T;
}

/**
 * Better Auth's in-session proofs for one staff member, handed out only after
 * one attempt of that person's budget is spent; each wrong answer is counted.
 * A request takes them once, before any try/catch that maps a failed proof to
 * "wrong password", so a 429 is never reported as a wrong guess.
 */
export async function staffProofs(env: Env, db: Database, auth: Auth, userId: string) {
  await enforceStaffProofLimit(env, db, userId);
  const fail = () => recordStaffProofFailure(db, userId);
  return {
    verifyPassword: counted(auth.api.verifyPassword, fail, (answer) => (answer as { status?: unknown } | null)?.status !== true),
    changePassword: counted(auth.api.changePassword, fail),
    verifyTOTP: counted(auth.api.verifyTOTP, fail),
    verifyTwoFactorOTP: counted(auth.api.verifyTwoFactorOTP, fail),
    verifyBackupCode: counted(auth.api.verifyBackupCode, fail),
    enableTwoFactor: counted(auth.api.enableTwoFactor, fail),
  };
}

export type StaffProofs = Awaited<ReturnType<typeof staffProofs>>;
