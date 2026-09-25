/**
 * The two validation rules of the DVC, behind the interfaces the property
 * harness drives. The reference implementations follow CACHE-DESIGN §6.6 and
 * §6.7 literally; S4 (API part cache) and S5 (storefront frontier) plug their
 * production functions in through the same interfaces
 * (see `harness-adapters.ts`), and the harness then proves those.
 */
import { createHash } from "node:crypto";
import type { ClockDelta, DvcClock } from "./clocks";

/** What a cached entry carries besides its body. */
export interface EntryMeta {
  /** Clock value read first in the render's session (min over parts for a page). */
  readonly s0: number;
  readonly deps: readonly string[];
  /** Epoch ms; never served at or after it. */
  readonly validUntil: number | null;
  /** Soft-ordering bound (owner decision 4), seconds after `renderedAt`. */
  readonly softMaxAgeSeconds: number | null;
  /** Epoch ms of the render. */
  readonly renderedAt: number;
}

export type Verdict =
  | { readonly valid: true; /** The entry's s0 after the check (raised to the checked clock). */ readonly s0: number }
  | { readonly valid: false; readonly reason: "changed" | "expired" | "floor" | "soft-age"; readonly keys?: readonly string[] };

/** Strict validation of API parts (G2, Δ = 0). */
export interface DvcPartValidator {
  readonly name: string;
  validate(entries: readonly EntryMeta[], now: number): Promise<Verdict[]>;
}

function timeVerdict(entry: EntryMeta, now: number): Verdict | null {
  if (entry.validUntil !== null && now >= entry.validUntil) return { valid: false, reason: "expired" };
  if (entry.softMaxAgeSeconds !== null && now - entry.renderedAt >= entry.softMaxAgeSeconds * 1000) {
    return { valid: false, reason: "soft-age" };
  }
  return null;
}

/** §6.6: one indexed read for the whole batch, `seq > min(s0)` over the union of keys. */
export function referencePartValidator(clock: DvcClock): DvcPartValidator {
  return {
    name: `reference-strict/${clock.name}`,
    async validate(entries, now) {
      if (entries.length === 0) return [];
      const union = [...new Set(entries.flatMap((entry) => entry.deps))];
      const minS0 = Math.min(...entries.map((entry) => entry.s0));
      const { S, changed, floor } = await clock.changedSince(union, minS0);
      return entries.map((entry): Verdict => {
        const timed = timeVerdict(entry, now);
        if (timed) return timed;
        if (entry.s0 < floor) return { valid: false, reason: "floor" };
        const keys = entry.deps.filter((dep) => (changed.get(dep) ?? -Infinity) > entry.s0);
        return keys.length > 0 ? { valid: false, reason: "changed", keys } : { valid: true, s0: Math.max(entry.s0, S) };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Storefront frontier (§6.7)
// ---------------------------------------------------------------------------

export interface Frontier {
  /** Time the refresh request was sent; S covers every commit acknowledged before it. */
  readonly sentAt: number;
  readonly S: number;
  /** Changes are complete for (horizon, S]. */
  readonly horizon: number;
  readonly floor: number;
  /** Dependency hash -> latest seq. */
  readonly changes: ReadonlyMap<string, number>;
}

export interface PageEntryMeta extends Omit<EntryMeta, "deps"> {
  /** Hashed dependency keys (names never leave the API). */
  readonly depHashes: readonly string[];
}

export type PageDecision = "serve" | "render" | "slow";

export interface DvcFrontierModel {
  readonly name: string;
  hashDep(dep: string): string;
  /** The object a refresher stores: `old` plus the fetched delta, trimmed to `cap`. */
  merge(old: Frontier | null, delta: ClockDelta & { horizon: number }, sentAt: number, cap: number): Frontier;
  /** The hit rule for a frontier already known to be fresh enough. */
  decide(entry: PageEntryMeta, frontier: Frontier, now: number): PageDecision;
}

/** 48-bit key hashes, as the storefront stores them. */
export function referenceDepHash(dep: string): string {
  return createHash("sha256").update(dep).digest("hex").slice(0, 12);
}

export function referenceFrontierModel(): DvcFrontierModel {
  return {
    name: "reference-frontier",
    hashDep: referenceDepHash,
    merge(old, delta, sentAt, cap) {
      const changes = new Map<string, number>(old && delta.horizon <= old.S ? old.changes : []);
      let horizon = old && delta.horizon <= old.S ? old.horizon : delta.horizon;
      for (const [dep, seq] of delta.changes) {
        const hash = referenceDepHash(dep);
        if ((changes.get(hash) ?? -Infinity) < seq) changes.set(hash, seq);
      }
      if (changes.size > cap) {
        const ordered = [...changes.entries()].sort((a, b) => b[1] - a[1]);
        const kept = ordered.slice(0, cap);
        // Everything at or below the newest dropped seq is no longer enumerated.
        horizon = Math.max(horizon, ordered[cap]![1]);
        changes.clear();
        for (const [hash, seq] of kept) if (seq > horizon) changes.set(hash, seq);
      }
      return { sentAt, S: delta.S, horizon, floor: delta.floor, changes };
    },
    decide(entry, frontier, now) {
      if (entry.validUntil !== null && now >= entry.validUntil) return "render";
      if (entry.softMaxAgeSeconds !== null && now - entry.renderedAt >= entry.softMaxAgeSeconds * 1000) return "render";
      if (entry.s0 < frontier.floor) return "render";
      if (entry.s0 < frontier.horizon) return "slow";
      for (const hash of entry.depHashes) {
        if ((frontier.changes.get(hash) ?? -Infinity) > entry.s0) return "render";
      }
      return "serve";
    },
  };
}
