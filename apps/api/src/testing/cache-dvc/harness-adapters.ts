/**
 * Adapters from the production DVC pieces to the harness interfaces.
 *
 * - `scopeRecorder`: S2's `withDependencyScope` around each part render, so
 *   the keys, `validUntil`, soft age and uncacheable reasons under test are
 *   the ones production records (S2's capture plus S3's declarations).
 * - S4's part validator and S5's frontier functions plug in through
 *   `DvcHarnessConfig.partValidator` / `frontierModel` when they land.
 */
import { withDependencyScope } from "@scalius/core/cache-deps";
import type { DependencyRecorder } from "./recorders";

export interface ScopeRecorderStats {
  /** Registered tables a render read that no declared key covered (fell back to `t:`). */
  coarse: Map<string, number>;
  /** Tables the harness saw a render touch that S2's observer did not report. */
  unobserved: Map<string, number>;
}

export function scopeRecorder(stats: ScopeRecorderStats, knownTables: ReadonlySet<string>): DependencyRecorder {
  return {
    name: "s2-scope",
    async record(label, render, observed) {
      const { value, dependencies } = await withDependencyScope(render, { label, log: () => undefined });
      const seen = new Set(dependencies.tables);
      for (const table of dependencies.coarseTables) {
        const key = `${label.split("?")[0]} ${table}`;
        stats.coarse.set(key, (stats.coarse.get(key) ?? 0) + 1);
      }
      for (const table of observed) {
        if (!seen.has(table) && knownTables.has(table)) {
          const key = `${label.split("?")[0]} ${table}`;
          stats.unobserved.set(key, (stats.unobserved.get(key) ?? 0) + 1);
        }
      }
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
