import type { Auth } from "@scalius/core/auth";
import { RateLimitError } from "./api-error";
import { isWithinRateLimit } from "./rate-limit";

/**
 * Every password or second-factor proof a staff member makes inside a session
 * (change password, confirm a 2FA change, turn 2FA off, verify a pending
 * session) counts against one per-person budget: the strict limiter, 5 a
 * minute. Better Auth limits only requests through its own router, by IP, and
 * its session path counts no failed codes, so a stolen session could otherwise
 * guess a password or a 6-digit code without end from rotating addresses.
 *
 * This module is the only caller of those Better Auth proofs in the API.
 */
export const STAFF_PROOF_LIMIT_PURPOSE = "staff-proof";
const STAFF_PROOF_RETRY_AFTER_SECONDS = 60;

/** Spends one proof attempt of this staff member; throws 429 once the minute's budget is gone. */
export async function enforceStaffProofLimit(env: Env, userId: string): Promise<void> {
  if (!(await isWithinRateLimit(env, "RL_STRICT", STAFF_PROOF_LIMIT_PURPOSE, userId))) {
    throw new RateLimitError("Too many attempts. Wait a minute and try again.", STAFF_PROOF_RETRY_AFTER_SECONDS);
  }
}

/**
 * Better Auth's in-session proofs for one staff member, handed out only after
 * one attempt of that person's budget is spent. A request takes them once, before
 * any try/catch that maps a failed proof to "wrong password", so a 429 is never
 * reported as a wrong guess.
 */
export async function staffProofs(env: Env, auth: Auth, userId: string) {
  await enforceStaffProofLimit(env, userId);
  return {
    verifyPassword: auth.api.verifyPassword,
    changePassword: auth.api.changePassword,
    verifyTOTP: auth.api.verifyTOTP,
    verifyTwoFactorOTP: auth.api.verifyTwoFactorOTP,
    verifyBackupCode: auth.api.verifyBackupCode,
  };
}

export type StaffProofs = Awaited<ReturnType<typeof staffProofs>>;
