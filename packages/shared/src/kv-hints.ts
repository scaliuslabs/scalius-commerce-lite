/**
 * Writes of optional KV hints. D1 is the authority for everything Scalius
 * stores in KV as a hint (permission snapshots, settings and Platform mirrors,
 * checkout and receipt recovery markers): a hint that is not written costs a D1
 * read later, never correctness. So a hint write must never fail the request
 * that wanted it, and once KV refuses writes (Workers Free allows 1,000 a day;
 * a key takes one a second) it must not keep asking.
 *
 * `putKvHint` and `deleteKvHint` never throw. A refusal that looks like a quota
 * or rate limit opens an in-isolate breaker: writes return false without
 * calling KV until it closes, and the pause doubles (30 s up to 10 min) while
 * the refusals continue, so an exhausted day costs a handful of failing calls
 * per isolate instead of one per hint. A successful write resets the backoff.
 * The breaker holds only a timestamp: no binding and nothing about the store.
 */

/** First pause after a refusal. */
export const KV_HINT_BREAKER_INITIAL_MS = 30_000;
/** Longest pause: Workers Free's daily quota resets at 00:00 UTC. */
export const KV_HINT_BREAKER_MAX_MS = 10 * 60_000;

let pausedUntil = 0;
let backoffMs = KV_HINT_BREAKER_INITIAL_MS;

type HintClock = () => number;

/** The refusal of a write over quota (`KV put() limit exceeded for the day.`) or over a key's rate (`429 Too Many Requests`). */
export function isKvWriteRefusal(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /limit exceeded|exceeded|too many requests|\b429\b|quota/i.test(text);
}

/** Whether hint writes are paused in this isolate. */
export function kvHintWritesPaused(now: HintClock = Date.now): boolean {
  return now() < pausedUntil;
}

/** Test seam: close the breaker and reset its backoff. */
export function resetKvHintBreaker(): void {
  pausedUntil = 0;
  backoffMs = KV_HINT_BREAKER_INITIAL_MS;
}

function tripBreaker(now: HintClock): void {
  pausedUntil = now() + backoffMs;
  backoffMs = Math.min(backoffMs * 2, KV_HINT_BREAKER_MAX_MS);
}

type KvWriter = Pick<KVNamespace, "put">;
type KvDeleter = Pick<KVNamespace, "delete">;

export interface PutKvHintOptions {
  expirationTtl?: number;
  expiration?: number;
  metadata?: object | null;
}

/** Writes a hint. Returns whether KV took it; never throws, never calls KV while the breaker is open. */
export async function putKvHint(
  kv: KvWriter | null | undefined,
  key: string,
  value: string,
  options?: PutKvHintOptions,
  now: HintClock = Date.now,
): Promise<boolean> {
  if (!kv || kvHintWritesPaused(now)) return false;
  try {
    await kv.put(key, value, options);
    backoffMs = KV_HINT_BREAKER_INITIAL_MS;
    return true;
  } catch (error) {
    if (isKvWriteRefusal(error)) tripBreaker(now);
    return false;
  }
}

/** Deletes a hint, the same way. */
export async function deleteKvHint(
  kv: KvDeleter | null | undefined,
  key: string,
  now: HintClock = Date.now,
): Promise<boolean> {
  if (!kv || kvHintWritesPaused(now)) return false;
  try {
    await kv.delete(key);
    backoffMs = KV_HINT_BREAKER_INITIAL_MS;
    return true;
  } catch (error) {
    if (isKvWriteRefusal(error)) tripBreaker(now);
    return false;
  }
}
