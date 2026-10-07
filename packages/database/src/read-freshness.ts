import { eq } from "drizzle-orm";

import { rateLimit } from "./schema";
import type { Database } from "./types";

/**
 * Probe row for {@link assertReadsAreUncached}. `rate_limit` is a private
 * table (no cache dependencies, no outbox triggers); Better Auth keys its rows
 * by "<ip>/<path>", so this key can never collide with a real limiter row.
 */
export const READ_FRESHNESS_PROBE_KEY = "__scalius:readyz:read-freshness";

const MAX_PROBE_VALUE = 2_000_000_000;

export class CachedReadError extends Error {
  constructor() {
    super(
      "reads are cached: run `wrangler hyperdrive update <id> --caching-disabled`",
    );
    this.name = "CachedReadError";
  }
}

function nextProbeValue(previous: number | null): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  const candidate = (values[0]! % MAX_PROBE_VALUE) + 1;
  return candidate === previous ? (candidate % MAX_PROBE_VALUE) + 1 : candidate;
}

/**
 * Fails when a plain read can return a value older than a committed write.
 *
 * Hyperdrive caches non-transactional reads for up to 75 s unless the
 * configuration has caching disabled. DVC frontier checks, idempotency rows
 * and checkout-authority reads are plain reads, so a cached read breaks the
 * one-second staleness bound and can replay a stale checkout decision.
 *
 * The probe reads one row, writes a new random value to it, then sends the
 * byte-identical read again. A query cache keyed by SQL text and parameters
 * answers the second read from the first, so it returns the old value.
 */
export async function assertReadsAreUncached(db: Database): Promise<void> {
  const read = async (): Promise<number | null> => {
    const rows = await db
      .select({ value: rateLimit.count })
      .from(rateLimit)
      .where(eq(rateLimit.key, READ_FRESHNESS_PROBE_KEY))
      .limit(1);
    return rows[0]?.value ?? null;
  };

  const before = await read();
  const value = nextProbeValue(before);
  const lastRequest = Date.now();
  await db
    .insert(rateLimit)
    .values({
      id: READ_FRESHNESS_PROBE_KEY,
      key: READ_FRESHNESS_PROBE_KEY,
      count: value,
      lastRequest,
    })
    .onConflictDoUpdate({
      target: rateLimit.key,
      set: { count: value, lastRequest },
    });
  const after = await read();
  if (after !== value) throw new CachedReadError();
}
