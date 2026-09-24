import { readAuthFailure, type AuthFailure } from "~/components/auth/auth-error";
import type { AccountMessageKey } from "~/i18n/account";

/**
 * The sentence for a failed account request. The screen names its own
 * mistakes (wrong code, wrong password); connection problems, rate limits and
 * server faults read the same everywhere, and raw server text never shows.
 */
export function accountFailureKey(
  error: unknown,
  pick: (failure: AuthFailure) => AccountMessageKey | null = () => null,
): AccountMessageKey {
  const failure = readAuthFailure(error);
  if (failure.offline) return "offline";
  if (failure.code === "TWO_FACTOR_LOCKED" || failure.code === "ACCOUNT_TEMPORARILY_LOCKED") return "locked";
  if (failure.status === 429) return "rateLimited";
  if (failure.status !== null && failure.status >= 500) return "unavailable";
  return pick(failure) ?? "unavailable";
}
