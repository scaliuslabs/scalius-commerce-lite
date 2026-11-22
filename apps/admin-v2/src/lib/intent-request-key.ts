import { sha256HexSync } from "@scalius/shared/hash";
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

/** A request key; outside a secure context (no `crypto.randomUUID`) still unique enough for one tab. */
export function newRequestKey(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

export function commandIntent(action: string, payload: unknown): string {
  return `${action}:${JSON.stringify(canonicalize(payload))}`;
}

/**
 * Answers that say the server refused this request and did nothing. A key
 * every send of which got one of these is abandoned: the next submit is a
 * new request. Any other answer (no answer, a 5xx, 408, 409, 425, 429)
 * leaves the outcome open, and from then on the key stays until the server
 * settles it: a later refusal may be the replay of a request that moved money.
 */
const REFUSED_AND_UNDONE = new Set([400, 401, 403, 404, 410, 413, 422]);

/**
 * The server's machine-readable answer to a different request under a used
 * key: the key's request was recorded. Read here only, by code or
 * `details.reason`, never by the message's words.
 */
const KEY_USED_CODES = new Set(["idempotency_key_reused"]);
const KEY_USED_REASONS = new Set(["request_key_reused"]);

export function keyAlreadyUsed(error: unknown): boolean {
  const answer = readAdminApiError(error);
  const reason = (answer?.details as { reason?: unknown } | undefined)?.reason;
  return KEY_USED_CODES.has(answer?.code ?? "") || (typeof reason === "string" && KEY_USED_REASONS.has(reason));
}

/** How a send settled, for the screen: done, the earlier request landed, refused with nothing done, or open. */
export type KeyOutcome = "done" | "landed" | "refused" | "open";

/**
 * One request key per intent (the action and its canonical payload): a
 * double submit of the same intent sends the same key, so the server replays
 * the first answer; a changed intent is a new request. After an open outcome
 * the next send reuses the key whatever its body, so the server either
 * replays the request that landed, refuses the different one as already used
 * (`keyAlreadyUsed`: the key ends and the screen says the earlier attempt went
 * through), or runs it because nothing was recorded. A key is never renewed
 * while a send of it is out, and it ends when every send has answered and the
 * server settled it.
 */
export class IntentRequestKey {
  private current: { intent: string; key: string } | null = null;
  private open = false;
  private sending = 0;
  private finished = false;
  private landed = false;

  constructor(private readonly createKey: (action: string) => string = newRequestKey) {}

  get(action: string, payload: unknown): string {
    // SHA-256 of the intent: the holder compares intents without keeping their inputs (licence keys, passwords).
    const intent = sha256HexSync(commandIntent(action, payload));
    this.landed = false;
    if (this.current && (this.sending > 0 || this.open || this.current.intent === intent) && !(this.finished && this.sending === 0)) {
      this.sending += 1;
      return this.current.key;
    }
    this.current = { intent, key: this.createKey(action) };
    this.open = false;
    this.finished = false;
    this.sending = 1;
    return this.current.key;
  }

  /** An earlier send of this key got no definite answer: it may have gone through. */
  get mayHaveLanded(): boolean {
    return this.open;
  }

  /** The server said the key's earlier request was recorded (until the next send). */
  get landedEarlier(): boolean {
    return this.landed;
  }

  clear(): void {
    this.current = null;
    this.open = false;
    this.finished = false;
  }

  /** After the call settled: `error` absent on success. */
  settled(error?: unknown): KeyOutcome {
    this.sending = Math.max(0, this.sending - 1);
    let outcome: KeyOutcome;
    if (error === undefined) {
      outcome = "done";
      this.finished = true;
      this.open = false;
    } else if (keyAlreadyUsed(error)) {
      outcome = "landed";
      this.finished = true;
      this.open = false;
      this.landed = true;
    } else {
      const status = readAdminApiError(error)?.status ?? null;
      if (status !== null && REFUSED_AND_UNDONE.has(status)) {
        outcome = this.open ? "open" : "refused";
        if (!this.open && this.sending === 0) this.finished = true;
      } else {
        outcome = "open";
        this.open = true;
      }
    }
    if (this.finished && this.sending === 0) {
      this.current = null;
      this.open = false;
      this.finished = false;
    }
    return outcome;
  }
}
