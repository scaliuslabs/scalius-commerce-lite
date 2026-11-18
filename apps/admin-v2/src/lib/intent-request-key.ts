import { readAdminApiError } from "./admin-api-error";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function commandIntent(action: string, payload: unknown): string {
  return `${action}:${JSON.stringify(canonicalize(payload))}`;
}

/**
 * Answers that say the server refused this request and did nothing: a retry
 * is a new request. Everything else keeps the key: 409 (a request with this
 * key is still running, or ran: its replay tells), 408, 425 and 429 (not
 * processed yet), a server fault, or no answer at all (the request may have
 * landed). A changed intent gets a new key anyway, so a 409 for a different
 * payload under the same key cannot arise.
 */
const REFUSED_AND_UNDONE = new Set([400, 401, 403, 404, 410, 413, 422]);

/**
 * One request key per intent (the action and its canonical payload): a
 * double submit of the same intent sends the same key, so the server replays
 * the first answer; a changed intent is a new request. After a success, or a
 * refusal that did nothing (`REFUSED_AND_UNDONE`), the next submit is a new
 * request too: a key the server recorded a failed attempt under would only
 * replay that failure. Any other answer keeps the key.
 */
export class IntentRequestKey {
  private current: { intent: string; key: string } | null = null;

  constructor(private readonly createKey: (action: string) => string = () => crypto.randomUUID()) {}

  get(action: string, payload: unknown): string {
    const intent = commandIntent(action, payload);
    if (this.current?.intent === intent) return this.current.key;
    const key = this.createKey(action);
    this.current = { intent, key };
    return key;
  }

  clear(): void {
    this.current = null;
  }

  /** After the call settled: `error` absent on success. */
  settled(error?: unknown): void {
    if (error === undefined) return this.clear();
    const status = readAdminApiError(error)?.status ?? null;
    if (status !== null && REFUSED_AND_UNDONE.has(status)) this.clear();
  }
}
