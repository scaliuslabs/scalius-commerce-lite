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
 * One request key per intent (the action and its canonical payload): a
 * double submit of the same intent sends the same key, so the server replays
 * the first answer; a changed intent is a new request. Once the server has
 * answered, with success or a refusal, the next submit is a new request too:
 * a key the server recorded a failure under would only replay that failure.
 * When no answer came (a lost connection, a server fault) the key stays,
 * because the request may have landed and its replay says how.
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
    const status = error === undefined ? null : readAdminApiError(error)?.status ?? null;
    if (error === undefined || (status !== null && status >= 400 && status < 500)) this.clear();
  }
}
