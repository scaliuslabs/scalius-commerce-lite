/**
 * Wire contract and pure rules of the dependency-validated cache (DVC)
 * between the API and the storefront (audit/rewrite-2026-09-23/CACHE-DESIGN.md
 * §6.6-6.8).
 *
 * - Dependency names never leave the API: the storefront sees each key as a
 *   48-bit hash (`hashCacheDep`). A collision can only make a hit rule reject
 *   more, never serve more.
 * - The API answers `GET /api/v1/storefront/frontier?since=<S>` with a
 *   `CacheFrontierDelta`: every key changed in `(horizon, S]` with its latest
 *   seq. A capped answer lowers `S` to the last complete clock value (or
 *   declares a horizon when one seq alone exceeds the limit); it never claims
 *   more than it holds. `clock` is the store clock at the read, so the caller
 *   knows whether to ask again.
 * - `POST /api/v1/storefront/frontier/check` is the slow path for an entry
 *   older than the frontier's horizon: hashes in, "changed after s0?" out.
 * - A storefront batch part in strict mode carries `StorefrontBatchPartCache`.
 *
 * `mergeCacheFrontier` and `decideCacheFrontierHit` are the storefront's hit
 * rule (§6.7); the S6 property harness proves exactly these functions.
 */

/** Header carrying the storefront's frontier key (HKDF purpose below). */
export const CACHE_FRONTIER_KEY_HEADER = "X-Scalius-Frontier-Key";
/** HKDF purpose of the frontier key, derived from `SCALIUS_SECRET` by both Workers. */
export const CACHE_FRONTIER_SECRET_PURPOSE = "cache-frontier";
/** API path of the frontier delta (GET) and, with `/check`, the slow path (POST). */
export const CACHE_FRONTIER_PATH = "/api/v1/storefront/frontier";
export const CACHE_FRONTIER_CHECK_PATH = "/api/v1/storefront/frontier/check";
/** Most changes one frontier answer (and one stored frontier) holds. */
export const CACHE_FRONTIER_MAX_CHANGES = 4_000;
/** Most hashes one slow-path check accepts (the entry key budget). */
export const CACHE_FRONTIER_CHECK_MAX_DEPS = 256;
/** Header of an admin write response: the store clock after the write committed (§6.10). */
export const CACHE_COMMIT_SEQ_HEADER = "X-Scalius-Commit-Seq";

/** One frontier answer. Complete for `(horizon, S]`. */
export interface CacheFrontierDelta {
  /** Clock value the answer is complete up to. */
  readonly S: number;
  /** Changes at or below it are not enumerated (entries rendered before it take the slow path). */
  readonly horizon: number;
  /** Entries rendered before it are invalid (pruned dependency rows). */
  readonly floor: number;
  /** The store clock when the answer was read; `S < clock` means ask again with `since = S`. */
  readonly clock: number;
  /** `[depHash, seq]`, oldest first. */
  readonly changes: ReadonlyArray<readonly [string, number]>;
}

/** The slow-path answer: whether any of the hashed keys changed after `s0`. */
export interface CacheFrontierCheck {
  /** The clock of the check; an unchanged entry may take it as its new s0. */
  readonly S: number;
  readonly floor: number;
  readonly changed: boolean;
}

/**
 * DVC metadata of one strict-mode batch part (the page's parts compose into
 * its entry: s0 = min, deps = union, validUntil and soft age = min,
 * renderedAt = min). A part without it (null) carries no proof: a page that
 * shows it must not be stored.
 */
export interface StorefrontBatchPartCache {
  /** Served from a validated entry, rendered with no entry, or re-rendered after its entry was rejected. */
  readonly status: "hit" | "miss" | "refresh";
  /** Clock value the part is known fresh at (raised to the validation clock on a hit). */
  readonly s0: number;
  /** Hashed dependency keys (`hashCacheDep`). */
  readonly deps: readonly string[];
  /** Epoch ms; never serve at or after it. */
  readonly validUntil: number | null;
  /** Soft-ordering bound (owner decision 4), seconds after `renderedAt`. */
  readonly softMaxAgeSeconds: number | null;
  /** Epoch ms of the part's render. */
  readonly renderedAt: number;
}

/**
 * The storefront's frontier object (one per data center and Worker version).
 * `sentAt` is when the refresh that produced `S` was sent: `S` covers every
 * commit acknowledged before it.
 */
export interface CacheFrontier {
  readonly sentAt: number;
  readonly S: number;
  readonly horizon: number;
  readonly floor: number;
  /** Dependency hash -> latest seq. */
  readonly changes: ReadonlyMap<string, number>;
}

/** A cached storefront page, as the hit rule sees it. */
export interface CacheFrontierEntry {
  readonly s0: number;
  readonly depHashes: readonly string[];
  readonly validUntil: number | null;
  readonly softMaxAgeSeconds: number | null;
  readonly renderedAt: number;
}

export type CacheFrontierDecision = "serve" | "render" | "slow";

/**
 * 48-bit hash of a dependency key, as 12 lower-case hex digits. Synchronous
 * and allocation-light (a page carries up to a few hundred keys); two
 * independent 32-bit multiply-xorshift lanes (cyrb53 construction).
 */
export function hashCacheDep(dep: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < dep.length; index += 1) {
    const code = dep.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, "0") + ((h2 >>> 0) & 0xffff).toString(16).padStart(4, "0");
}

const HASH_PATTERN = /^[0-9a-f]{12}$/;

export function isCacheDepHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * The frontier a refresher stores: `old` plus the fetched delta, trimmed to
 * the newest `cap` changes with the horizon raised to match. A delta that does
 * not connect to `old` (its horizon is above `old.S`) replaces it. A racing,
 * older refresh can only store a smaller `S`: it claims less, never more.
 */
export function mergeCacheFrontier(
  old: CacheFrontier | null,
  delta: Pick<CacheFrontierDelta, "S" | "horizon" | "floor" | "changes">,
  sentAt: number,
  cap: number = CACHE_FRONTIER_MAX_CHANGES,
): CacheFrontier {
  const connects = old !== null && delta.horizon <= old.S;
  const changes = new Map<string, number>(connects ? old.changes : []);
  let horizon = connects ? old.horizon : delta.horizon;
  const floor = Math.max(delta.floor, connects ? old.floor : 0);
  for (const [hash, seq] of delta.changes) {
    if ((changes.get(hash) ?? -Infinity) < seq) changes.set(hash, seq);
  }
  horizon = Math.max(horizon, floor);
  if (changes.size > cap) {
    const ordered = [...changes.entries()].sort((a, b) => b[1] - a[1]);
    // Everything at or below the newest dropped seq is no longer enumerated.
    horizon = Math.max(horizon, ordered[cap]![1]);
    changes.clear();
    for (const [hash, seq] of ordered.slice(0, cap)) if (seq > horizon) changes.set(hash, seq);
  }
  return { sentAt, S: delta.S, horizon, floor, changes };
}

/**
 * The page hit rule (§6.7) for a frontier already known to be fresh enough
 * (`now - sentAt <= Δ`, and `S >= _sv` when the request carries one).
 */
export function decideCacheFrontierHit(
  entry: CacheFrontierEntry,
  frontier: CacheFrontier,
  now: number,
): CacheFrontierDecision {
  if (entry.validUntil !== null && now >= entry.validUntil) return "render";
  if (entry.softMaxAgeSeconds !== null && now - entry.renderedAt >= entry.softMaxAgeSeconds * 1000) return "render";
  if (entry.s0 < frontier.floor) return "render";
  if (entry.s0 < frontier.horizon) return "slow";
  for (const hash of entry.depHashes) {
    if ((frontier.changes.get(hash) ?? -Infinity) > entry.s0) return "render";
  }
  return "serve";
}
