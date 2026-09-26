/**
 * Adapters from the production DVC pieces to the harness interfaces.
 *
 * - `scopeRecorder`: S2's `withDependencyScope` around each part render, so
 *   the keys, `validUntil`, soft age and uncacheable reasons under test are
 *   the ones production records (S2's capture plus S3's declarations).
 * - `s4Adapters`: S4's production part cache, end to end:
 *   - the recorder renders exactly as the strict part reader does: s0 is the
 *     data center's clock snapshot taken before the render (possibly older
 *     than the clock: a lower bound, never read after the data), and the
 *     Platform settings row comes preloaded from that same snapshot;
 *   - the part validator is `validateDvcEntries` (one statement);
 *   - the frontier delta is `readFrontierDelta` (hashed keys, capped answers
 *     lower S), merged and judged by `@scalius/shared/cache-frontier`.
 *   Every validation statement may refresh the snapshot, as a batch's
 *   statement refreshes the data center's copy; `snapshotRefreshRate` below 1
 *   keeps it stale on purpose.
 */
import type { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Binding } from "@scalius/database/testing/sqlite-d1";
import { withDependencyScope } from "@scalius/core/cache-deps";
import { platformSettingsFromRow } from "@scalius/core/modules/platform";
import {
  decideCacheFrontierHit,
  hashCacheDep,
  mergeCacheFrontier,
} from "@scalius/shared/cache-frontier";
import { readFrontierDelta, readValidationSnapshot, type ValidationSnapshot } from "../../cache-frontier";
import { validateDvcEntries } from "../../public-read";
import { runWithPublicRenderContext } from "../../runtime/public-render-context";
import type { DvcClock } from "./clocks";
import type { DependencyRecorder } from "./recorders";
import type { SchemaModel } from "./schema-model";
import type { DvcFrontierModel, DvcPartValidator } from "./validators";

export interface ScopeRecorderStats {
  /** Registered tables a render read that no declared key covered (fell back to `t:`). */
  coarse: Map<string, number>;
  /** Tables the harness saw a render touch that S2's observer did not report. */
  unobserved: Map<string, number>;
}

function countCoverage(stats: ScopeRecorderStats, knownTables: ReadonlySet<string>, label: string, tables: readonly string[], coarse: readonly string[], observed: ReadonlySet<string>): void {
  const seen = new Set(tables);
  for (const table of coarse) {
    const key = `${label.split("?")[0]} ${table}`;
    stats.coarse.set(key, (stats.coarse.get(key) ?? 0) + 1);
  }
  for (const table of observed) {
    if (!seen.has(table) && knownTables.has(table)) {
      const key = `${label.split("?")[0]} ${table}`;
      stats.unobserved.set(key, (stats.unobserved.get(key) ?? 0) + 1);
    }
  }
}

export function scopeRecorder(stats: ScopeRecorderStats, knownTables: ReadonlySet<string>): DependencyRecorder {
  return {
    name: "s2-scope",
    async record(label, render, observed) {
      const { value, dependencies } = await withDependencyScope(render, { label, log: () => undefined });
      countCoverage(stats, knownTables, label, dependencies.tables, dependencies.coarseTables, observed);
      return {
        response: value,
        dependencies: {
          deps: dependencies.keys,
          validUntil: dependencies.validUntil,
          softMaxAgeSeconds: dependencies.softMaxAgeSeconds,
          uncacheable: dependencies.uncacheable,
        },
      };
    },
  };
}

export interface S4AdapterOptions {
  /** The database S4's statements run on (default: Drizzle over a D1 binding of the harness SQLite). */
  readonly database?: (sqlite: DatabaseSync) => Database;
  /** Probability that a validation statement refreshes the snapshot renders take s0 from (1 = always). */
  readonly snapshotRefreshRate?: number;
  /** Seeded randomness for the refresh decision. */
  readonly random?: () => number;
  /**
   * Negative control only: take s0 from a clock read after the render (the
   * ordering bug §6.8 L2 rules out). The property harness must catch it.
   */
  readonly clockAfterRender?: boolean;
  /** Negative control only: the validator ignores keys matching this. */
  readonly blindTo?: RegExp;
}

export interface S4Adapters {
  recorder(stats: ScopeRecorderStats): (context: { sqlite: DatabaseSync; model: SchemaModel }) => DependencyRecorder;
  partValidator(clock: DvcClock): DvcPartValidator;
  readonly frontierModel: DvcFrontierModel;
  readonly stats: { snapshotReads: number; snapshotRefreshes: number; staleSnapshotRenders: number; clockAhead: number };
}

export function s4Adapters(options: S4AdapterOptions = {}): S4Adapters {
  let database: Database | null = null;
  let snapshot: ValidationSnapshot | null = null;
  const random = options.random ?? Math.random;
  const refreshRate = options.snapshotRefreshRate ?? 1;
  const stats = { snapshotReads: 0, snapshotRefreshes: 0, staleSnapshotRenders: 0, clockAhead: 0 };
  const db = () => {
    if (!database) throw new Error("s4Adapters: the recorder factory must run before the validator (DvcHarness.create order)");
    return database;
  };
  const offer = (fresh: ValidationSnapshot) => {
    if (snapshot === null || random() < refreshRate) {
      snapshot = fresh;
      stats.snapshotRefreshes += 1;
    }
  };
  return {
    stats,
    recorder(recorderStats) {
      return ({ sqlite, model }) => {
        database = options.database?.(sqlite) ?? (drizzle(createSqliteD1Binding(sqlite), { schema }) as unknown as Database);
        const knownTables = new Set(model.keys());
        return {
          name: options.clockAfterRender ? "s4-reader(clock-after-render)" : "s4-reader",
          async record(label, render, observed) {
            if (snapshot === null) {
              stats.snapshotReads += 1;
              offer(await readValidationSnapshot(db(), [], 0));
            }
            const base = snapshot!;
            const platform = await platformSettingsFromRow(base.platform);
            const { value, dependencies } = await withDependencyScope(
              () => runWithPublicRenderContext({ platform }, render),
              { label, log: () => undefined },
            );
            countCoverage(recorderStats, knownTables, label, dependencies.tables, dependencies.coarseTables, observed);
            let s0 = base.S;
            if (options.clockAfterRender) s0 = (await readValidationSnapshot(db(), [], 0)).S;
            else {
              const now = (await readValidationSnapshot(db(), [], 0)).S;
              if (now > base.S) stats.staleSnapshotRenders += 1;
            }
            return {
              response: value,
              dependencies: {
                deps: dependencies.keys,
                validUntil: dependencies.validUntil,
                softMaxAgeSeconds: dependencies.softMaxAgeSeconds,
                uncacheable: dependencies.uncacheable,
                s0,
              },
            };
          },
        };
      };
    },
    partValidator(clock) {
      // The storefront's frontier refreshes read S4's endpoint query.
      (clock as { frontierDelta: DvcClock["frontierDelta"] }).frontierDelta = async (since, limit) => {
        const delta = await readFrontierDelta(db(), since, limit);
        if (delta.S > delta.clock) stats.clockAhead += 1;
        return delta;
      };
      return {
        name: options.blindTo ? "s4-strict(blind)" : "s4-strict",
        async validate(entries, now) {
          if (entries.length === 0) return [];
          const seen = options.blindTo
            ? entries.map((entry) => ({ ...entry, deps: entry.deps.filter((dep) => !options.blindTo!.test(dep)) }))
            : entries;
          const { verdicts, snapshot: fresh } = await validateDvcEntries(db(), seen, now);
          offer(fresh);
          return verdicts;
        },
      };
    },
    frontierModel: {
      name: "s4-frontier",
      hashDep: hashCacheDep,
      // S4's delta already carries hashed keys.
      merge: (old, delta, sentAt, cap) => mergeCacheFrontier(old, delta, sentAt, cap),
      decide: (entry, frontier, now) => decideCacheFrontierHit(entry, frontier, now),
    },
  };
}
