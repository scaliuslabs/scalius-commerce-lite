import { isEmailAddress } from "@scalius/shared/text-scan";
import type { AuthMessageKey } from "~/i18n/auth";

/** A catalog message kept as a key, so it follows a language switch. */
export interface AuthMessage {
  key: AuthMessageKey;
  vars?: Record<string, number>;
}

/** What a failed auth request tells us, from Better Auth, the admin API or fetch itself. */
export interface AuthFailure {
  status: number | null;
  code: string;
  offline: boolean;
  /** The wait a refusal named (`retryAfterSeconds` in its body or `details`), or null. */
  retryAfterSeconds: number | null;
}

/** The rate-limit sentence for a wait the server named; the plain one when it named none. */
export function rateLimitWait(seconds: unknown): {
  key: "rateLimited" | "rateLimitedSeconds" | "rateLimitedMinutes";
  vars?: Record<string, number>;
} {
  const wait = Math.ceil(Number(seconds));
  if (seconds === null || seconds === undefined || seconds === "" || !Number.isFinite(wait) || wait <= 0) return { key: "rateLimited" };
  return wait < 60
    ? { key: "rateLimitedSeconds", vars: { count: wait } }
    : { key: "rateLimitedMinutes", vars: { count: Math.ceil(wait / 60) } };
}

const NETWORK_FAILURE = /failed to fetch|fetch failed|load failed|networkerror|network request failed/i;

function field(source: unknown, key: string): unknown {
  return typeof source === "object" && source !== null ? Reflect.get(source, key) : undefined;
}

export function readAuthFailure(error: unknown): AuthFailure {
  // Better Auth returns `{ code, message, status }`; its throwing client and the
  // admin API transport put the status on the error and the body under `error`.
  const body = field(error, "error");
  const status =
    [field(error, "status"), field(error, "statusCode"), field(body, "status")]
      .map(Number)
      .find((value) => Number.isInteger(value) && value >= 400) ?? null;
  const code = [field(body, "code"), field(error, "code")].find((value) => typeof value === "string") as string | undefined;
  const message = error instanceof Error ? error.message : String(field(error, "message") ?? "");
  const offline =
    status === null && (NETWORK_FAILURE.test(message) || (typeof navigator !== "undefined" && navigator.onLine === false));
  const retryAfterSeconds = [
    field(error, "retryAfterSeconds"),
    field(body, "retryAfterSeconds"),
    field(field(error, "details"), "retryAfterSeconds"),
    field(field(body, "details"), "retryAfterSeconds"),
  ].map(Number).find((value) => Number.isFinite(value) && value > 0) ?? null;
  return { status, code: (code ?? "").toUpperCase(), offline, retryAfterSeconds };
}

/**
 * The message for a failed auth request. Connection problems, rate limits,
 * the 2FA lockout and server faults read the same on every screen; `pick`
 * names the screen's own messages (wrong password, wrong code). A rate limit
 * says how long to wait when the server told us (`X-Retry-After`, or the wait
 * in the refusal's body).
 */
export function authFailureMessage(
  error: unknown,
  pick: (failure: AuthFailure) => AuthMessageKey | null,
  retryAfter?: string | null,
): AuthMessage {
  const failure = readAuthFailure(error);
  if (failure.offline) return { key: "offline" };
  // Better Auth answers the 2FA lockout with 429 too; it lasts 15 minutes.
  if (failure.code === "ACCOUNT_TEMPORARILY_LOCKED") return { key: "locked" };
  if (failure.status === 429) return rateLimitWait(retryAfter || failure.retryAfterSeconds);
  if (failure.status !== null && failure.status >= 500) return { key: "unavailable" };
  return { key: pick(failure) ?? "unavailable" };
}

/** The email field's message: empty, or clearly not an address. The server decides the rest. */
export function emailError(email: string): AuthMessageKey | null {
  if (!email.trim()) return "emailRequired";
  return isEmailAddress(email.trim()) ? null : "emailInvalid";
}

/** Same bounds as the API (AUTH_PASSWORD_MIN/MAX_LENGTH in packages/core/src/auth/credential-account.ts). */
export function newPasswordError(password: string): AuthMessageKey | null {
  if (password.length < 12) return "passwordTooShort";
  return password.length > 128 ? "passwordTooLong" : null;
}
