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
 * Answers that say the server refused this request and did nothing. A key
 * every send of which got one of these is abandoned: the next submit is a
 * new request. Any other answer (no answer, a 5xx, 408, 409, 425, 429)
 * leaves the outcome open, and from then on the key stays until a success:
 * a later refusal may be the replay of a request that moved money.
 */
const REFUSED_AND_UNDONE = new Set([400, 401, 403, 404, 410, 413, 422]);

/**
 * One request key per intent (the action and its canonical payload): a
 * double submit of the same intent sends the same key, so the server replays
 * the first answer; a changed intent is a new request, unless an earlier
 * send's outcome is open, when the key stays (`mayHaveLanded`). A success
 * ends the key.
 */
export class IntentRequestKey {
  private current: { intent: string; key: string } | null = null;
  private open = false;

  constructor(private readonly createKey: (action: string) => string = () => crypto.randomUUID()) {}

  get(action: string, payload: unknown): string {
    const intent = commandIntent(action, payload);
    if (this.current && (this.open || this.current.intent === intent)) return this.current.key;
    const key = this.createKey(action);
    this.current = { intent, key };
    return key;
  }

  /** An earlier send of this key got no definite answer: it may have gone through. */
  get mayHaveLanded(): boolean {
    return this.open;
  }

  clear(): void {
    this.current = null;
    this.open = false;
  }

  /** After the call settled: `error` absent on success. */
  settled(error?: unknown): void {
    if (error === undefined) return this.clear();
    const status = readAdminApiError(error)?.status ?? null;
    if (status !== null && REFUSED_AND_UNDONE.has(status)) {
      if (!this.open) this.clear();
      return;
    }
    this.open = true;
  }
}
