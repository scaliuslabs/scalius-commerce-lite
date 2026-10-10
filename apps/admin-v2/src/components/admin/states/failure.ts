import { readAdminApiError } from "~/lib/admin-api-error";
import { isRecoverableRouteLoadError } from "~/lib/recoverable-route-error";
import { isOnline } from "./online-status";

export { isOnline };

/**
 * Why a read failed, so every screen words it the same way:
 * - `offline`: the browser says it has no connection;
 * - `unreachable`: online, but no answer came (a dead network, a timeout);
 * - `unavailable`: Scalius answered with a gateway error (502–504);
 * - `notFound` / `forbidden`: the record is gone, or not this person's to see;
 * - `updated`: a new version replaced this tab's code (a deploy);
 * - `broken`: anything else (a fault on our side, or in the page).
 */
export type FailureKind = "offline" | "unreachable" | "unavailable" | "notFound" | "forbidden" | "updated" | "broken";

const NO_ANSWER = /failed to fetch|load failed|networkerror|network request failed|timed? ?out/i;
// A TypeError is a fetch with no answer only when its message says so; otherwise it is a bug.
const NO_ANSWER_NAMES = new Set(["AbortError", "TimeoutError"]);

export function classifyFailure(error: unknown, online = isOnline()): FailureKind {
  if (error == null) return online ? "broken" : "offline";
  // A page's code that failed to download offline is a connection problem, not a deploy.
  if (isRecoverableRouteLoadError(error)) return online ? "updated" : "offline";
  // The browser itself says it is offline: whatever came back, that is the cause.
  if (!online) return "offline";
  const status = readAdminApiError(error)?.status ?? null;
  if (status === 404 || status === 410) return "notFound";
  if (status === 403) return "forbidden";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  if (status !== null) return "broken";
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (NO_ANSWER.test(message) || (error instanceof Error && NO_ANSWER_NAMES.has(error.name))) return "unreachable";
  return "broken";
}

/** Failures that end by themselves when the connection or server comes back. */
export function retriesWhenOnline(kind: FailureKind): boolean {
  return kind === "offline" || kind === "unreachable" || kind === "unavailable";
}
