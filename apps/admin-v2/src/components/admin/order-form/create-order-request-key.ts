const STORAGE_KEY = "scalius:admin-order-create-request:v1";
const MAX_RECOVERY_AGE_MS = 24 * 60 * 60 * 1_000;

interface StoredRequestKey {
  requestKey: string;
  submittedAt: number;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readRecoverableRequestKey(now = Date.now()): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<StoredRequestKey> | null;
    if (
      !stored ||
      !isUuid(stored.requestKey) ||
      typeof stored.submittedAt !== "number" ||
      now - stored.submittedAt > MAX_RECOVERY_AGE_MS
    ) {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return stored.requestKey;
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/**
 * Reuses only a previously submitted request. An untouched form receives a new
 * key, so visiting the new-order page never inherits an unrelated draft.
 */
export function getOrCreateAdminOrderRequestKey(): string {
  return readRecoverableRequestKey() ?? crypto.randomUUID();
}

/** Persist the opaque key immediately before the request leaves the browser. */
export function rememberSubmittedAdminOrderRequestKey(requestKey: string): void {
  if (typeof window === "undefined" || !isUuid(requestKey)) return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
    requestKey,
    submittedAt: Date.now(),
  } satisfies StoredRequestKey));
}

export function clearAdminOrderRequestKey(requestKey?: string): void {
  if (typeof window === "undefined") return;
  if (requestKey) {
    const current = readRecoverableRequestKey();
    if (current && current !== requestKey) return;
  }
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export const adminOrderRequestKeyStorage = {
  key: STORAGE_KEY,
  maxRecoveryAgeMs: MAX_RECOVERY_AGE_MS,
};
