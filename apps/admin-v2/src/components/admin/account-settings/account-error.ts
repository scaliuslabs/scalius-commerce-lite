import { rateLimitWait, readAuthFailure, type AuthFailure } from "~/components/auth/auth-error";
import type { AccountMessageKey } from "~/i18n/account";

/** A catalog message kept as a key (and its numbers), so it follows a language switch. */
export interface AccountMessage {
  key: AccountMessageKey;
  vars?: Record<string, number>;
}

/**
 * The sentence for a failed account request. The screen names its own
 * mistakes (wrong code, wrong password); connection problems, rate limits and
 * server faults read the same everywhere, and raw server text never shows. A
 * rate limit says how long to wait when the server named it.
 */
export function accountFailureMessage(
  error: unknown,
  pick: (failure: AuthFailure) => AccountMessageKey | null = () => null,
): AccountMessage {
  const failure = readAuthFailure(error);
  if (failure.offline) return { key: "offline" };
  if (failure.code === "TWO_FACTOR_LOCKED" || failure.code === "ACCOUNT_TEMPORARILY_LOCKED") return { key: "locked" };
  if (failure.status === 429) return rateLimitWait(failure.retryAfterSeconds);
  if (failure.status !== null && failure.status >= 500) return { key: "unavailable" };
  return { key: pick(failure) ?? "unavailable" };
}
