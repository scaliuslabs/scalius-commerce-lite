import {
  CACHE_FRONTIER_CHECK_MAX_DEPS,
  DEPENDENCY_CACHE_RETENTION_SECONDS,
  CACHE_FRONTIER_CHECK_PATH,
  CACHE_FRONTIER_KEY_HEADER,
  CACHE_FRONTIER_PATH,
  isCacheDepHash,
  mergeCacheFrontier,
  type CacheFrontier,
  type CacheFrontierCheck,
  type CacheFrontierDelta,
} from "@scalius/shared/cache-frontier";

/**
 * The storefront's per-data-center change frontier (CACHE-DESIGN §6.7): the
 * dependency hashes changed recently, never older than Δ when a page hit is
 * validated against it. One Cache API object per data center, build and
 * Worker version; refreshed from the API over the service binding.
 */

/** Δ: a page served at t reflects every write acknowledged before t - Δ. */
export const CACHE_FRONTIER_DELTA_MS = 1_000;
/** A frontier call that takes longer fails the hit (the page renders live). */
export const CACHE_FRONTIER_TIMEOUT_MS = 1_500;
/** Delta pages one refresh reads before it gives up on catching up. */
const MAX_REFRESH_ROUNDS = 4;

export interface CacheFrontierClient {
  delta(since: number | null): Promise<CacheFrontierDelta>;
  check(s0: number, depHashes: readonly string[]): Promise<CacheFrontierCheck>;
}

export function cacheFrontierKey(origin: string, buildId: string, workerVersion: string): string {
  return `${origin}/__scalius/frontier/${encodeURIComponent(buildId)}/${encodeURIComponent(workerVersion)}`;
}

const isClock = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseChanges(value: unknown): Array<readonly [string, number]> | null {
  if (!Array.isArray(value)) return null;
  const changes: Array<readonly [string, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || !isCacheDepHash(item[0]) || !isClock(item[1])) return null;
    changes.push([item[0], item[1]]);
  }
  return changes;
}

export function parseCacheFrontierDelta(value: unknown): CacheFrontierDelta | null {
  const data = value as Partial<Record<keyof CacheFrontierDelta, unknown>> | null;
  if (!data || typeof data.apiVersion !== "string" || !data.apiVersion || !isClock(data.S) || !isClock(data.horizon) || !isClock(data.floor) || !isClock(data.clock)) return null;
  const changes = parseChanges(data.changes);
  return changes ? { apiVersion: data.apiVersion, S: data.S, horizon: data.horizon, floor: data.floor, clock: data.clock, changes } : null;
}

export function serializeCacheFrontier(frontier: CacheFrontier): string {
  return JSON.stringify({
    apiVersion: frontier.apiVersion,
    sentAt: frontier.sentAt,
    S: frontier.S,
    horizon: frontier.horizon,
    floor: frontier.floor,
    changes: [...frontier.changes],
  });
}

export function parseCacheFrontier(text: string): CacheFrontier | null {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!data || typeof data.apiVersion !== "string" || !data.apiVersion || !isClock(data.sentAt) || !isClock(data.S) || !isClock(data.horizon) || !isClock(data.floor)) return null;
  const changes = parseChanges(data.changes);
  if (!changes) return null;
  return { apiVersion: data.apiVersion, sentAt: data.sentAt, S: data.S, horizon: data.horizon, floor: data.floor, changes: new Map(changes) };
}

export async function readStoredCacheFrontier(
  cache: Pick<Cache, "match">,
  key: string,
): Promise<CacheFrontier | null> {
  const stored = await cache.match(key);
  return stored ? parseCacheFrontier(await stored.text()) : null;
}

export function storeCacheFrontier(
  cache: Pick<Cache, "put">,
  key: string,
  frontier: CacheFrontier,
): Promise<void> {
  return cache.put(key, new Response(serializeCacheFrontier(frontier), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${DEPENDENCY_CACHE_RETENTION_SECONDS}`,
    },
  }));
}

/**
 * `old` brought up to the store clock. `sentAt` is taken before the first
 * call, so `S` covers every commit acknowledged before it; a refresh that
 * could not catch up (every page capped) fails closed: its `S` cannot prove
 * the merchant's observed write is included.
 */
export async function refreshCacheFrontier(
  old: CacheFrontier | null,
  client: CacheFrontierClient,
  now: () => number = Date.now,
): Promise<CacheFrontier | null> {
  const sentAt = now();
  let frontier = old;
  for (let round = 0; round < MAX_REFRESH_ROUNDS; round += 1) {
    const delta = await client.delta(frontier?.S ?? null);
    frontier = mergeCacheFrontier(frontier, delta, sentAt);
    if (delta.S >= delta.clock) return frontier;
  }
  return null;
}

/** Whether a stored frontier may validate a hit at `now` for a request that saw `seenSeq`. */
export function isCacheFrontierFresh(
  frontier: CacheFrontier | null,
  now: number,
  seenSeq: number | null,
): frontier is CacheFrontier {
  return frontier !== null
    && now >= frontier.sentAt
    && now - frontier.sentAt <= CACHE_FRONTIER_DELTA_MS
    && (seenSeq === null || frontier.S >= seenSeq);
}

/**
 * The frontier API over the storefront's service binding, authenticated with
 * the frontier key (HKDF of SCALIUS_SECRET). Any failure throws: the caller
 * renders instead of serving an entry it cannot prove fresh.
 */
export function createCacheFrontierClient(
  fetcher: (request: Request) => Promise<Response>,
  origin: string,
  frontierKey: () => Promise<string>,
): CacheFrontierClient {
  async function call(path: string, init: RequestInit): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set(CACHE_FRONTIER_KEY_HEADER, await frontierKey());
    const response = await fetcher(new Request(`${origin}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(CACHE_FRONTIER_TIMEOUT_MS),
    }));
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`frontier ${response.status}`);
    }
    return ((await response.json()) as { data?: unknown }).data;
  }
  return {
    async delta(since) {
      const query = since === null ? "" : `?since=${since}`;
      const delta = parseCacheFrontierDelta(await call(`${CACHE_FRONTIER_PATH}${query}`, { method: "GET" }));
      if (!delta) throw new Error("frontier answer malformed");
      return delta;
    },
    async check(s0, depHashes) {
      const chunks: string[][] = depHashes.length === 0 ? [[]] : [];
      for (let index = 0; index < depHashes.length; index += CACHE_FRONTIER_CHECK_MAX_DEPS) {
        chunks.push(depHashes.slice(index, index + CACHE_FRONTIER_CHECK_MAX_DEPS));
      }
      const answers = await Promise.all(chunks.map(async (deps) => {
        const data = await call(CACHE_FRONTIER_CHECK_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ s0, deps }),
        }) as Partial<CacheFrontierCheck> | null;
        if (!data || typeof data.apiVersion !== "string" || !data.apiVersion || !isClock(data.S) || !isClock(data.floor) || typeof data.changed !== "boolean") {
          throw new Error("frontier check malformed");
        }
        return data as CacheFrontierCheck;
      }));
      if (answers.some((answer) => answer.apiVersion !== answers[0]!.apiVersion)) {
        throw new Error("frontier check crossed API versions");
      }
      // Every chunk read its own clock: the smallest S holds for all of them.
      return {
        apiVersion: answers[0]!.apiVersion,
        S: Math.min(...answers.map((answer) => answer.S)),
        floor: Math.max(...answers.map((answer) => answer.floor)),
        changed: answers.some((answer) => answer.changed),
      };
    },
  };
}
