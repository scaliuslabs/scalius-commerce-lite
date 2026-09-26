/**
 * The pure half of dependency recording: from what a render read (tables) and
 * what it declared (keys), derive the key set its cache entry depends on.
 *
 * - Coverage: a table the render touched is covered by a declared key of one
 *   of the kinds the registry lists for it (`cacheDepKindsForTable`), or by its
 *   own `t:<table>`. A table read by row identity
 *   (`CACHE_DEP_ROW_KEYED_TABLES`: settings) is covered by the rows read
 *   instead: every statement that touched it must pin the documents it reads
 *   (`pinnedSourceValues`), and each of their own keys must be declared.
 *   An uncovered registered table falls back to `t:<table>`.
 * - Exempt tables need nothing. Recommendation and sales projections are
 *   registered hard dependencies; no table imposes an age-based expiry.
 * - A table neither registered nor exempt cannot be proven fresh: the entry is
 *   uncacheable.
 * - Budget: above `CACHE_DEP_ENTRY_KEY_BUDGET` keys, the most numerous kinds
 *   collapse to the `t:` keys of every table that advances them.
 * - `store` is always a key: the dashboard "clear cache" and catalogue-wide
 *   rebuilds advance only `store`.
 */
import {
  CACHE_DEP_ENTRY_KEY_BUDGET,
  CACHE_DEP_ROW_KEYED_TABLES,
  CACHE_DEP_TABLES,
  cacheDep,
  cacheDepExemptReason,
  cacheDepKind,
  cacheDepKindsForTable,
  cacheDepPinnedRowsCovered,
  type CacheDepKind,
} from "@scalius/shared/cache-deps";
import { pinnedSourceValues } from "@scalius/database/read-observer";

/** No registered read relies on an age-based freshness bound. */
export const CACHE_DEP_SOFT_TABLES: ReadonlySet<string> = new Set();

/** For each kind, the coarse `t:` keys of every registered table that can advance it. */
const COARSE_KEYS_BY_KIND: ReadonlyMap<CacheDepKind, readonly string[]> = (() => {
  const byKind = new Map<CacheDepKind, string[]>();
  for (const [table, spec] of Object.entries(CACHE_DEP_TABLES)) {
    for (const kind of spec.kinds as readonly CacheDepKind[]) {
      const keys = byKind.get(kind) ?? [];
      keys.push(cacheDep.table(table));
      byKind.set(kind, keys);
    }
  }
  return byKind;
})();

/** The coarse `t:` keys a kind collapses to, or an empty list for kinds that cannot collapse. */
export function coarseKeysForKind(kind: CacheDepKind): readonly string[] {
  return COARSE_KEYS_BY_KIND.get(kind) ?? [];
}

export interface CacheDepResolveInput {
  /** Well-formed declared keys (`isCacheDep`). */
  readonly declared: Iterable<string>;
  /** Tables the render touched, lower-case. */
  readonly tables: Iterable<string>;
  /**
   * Every bound execution of a statement that touched a row-keyed table, with
   * its SQL and parameters. A row-keyed table read with no reported statement
   * is uncovered.
   */
  readonly rowKeyedStatements?: Iterable<CacheDepRowKeyedStatement>;
  readonly budget?: number;
}

export interface CacheDepRowKeyedStatement {
  readonly tables: readonly string[];
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Whether every read of a row-keyed table pinned the rows it can match, and
 * the key of each of those rows was declared.
 */
function rowKeyedTableCovered(
  table: string,
  statements: readonly CacheDepRowKeyedStatement[],
  keys: ReadonlySet<string>,
): boolean {
  const spec = CACHE_DEP_ROW_KEYED_TABLES[table];
  if (spec === undefined) return false;
  const reads = statements.filter((statement) => statement.tables.includes(table));
  if (reads.length === 0) return false;
  return reads.every((statement) => {
    const sources = pinnedSourceValues(statement.sql, statement.params, table, spec.columns);
    return sources.length > 0 && sources.every((pinned) => cacheDepPinnedRowsCovered(table, pinned, keys));
  });
}

export interface CacheDepResolution {
  /** The entry's keys, sorted and unique, `store` included. */
  readonly keys: readonly string[];
  /** Registered tables no declared key covered; each added its `t:` key. */
  readonly coarseTables: readonly string[];
  /** Soft tables read; the entry carries the soft max age. */
  readonly softTables: readonly string[];
  /** Tables neither registered nor exempt: the entry is uncacheable. */
  readonly unregisteredTables: readonly string[];
  /** Kinds the budget collapsed to their coarse keys. */
  readonly collapsedKinds: readonly CacheDepKind[];
  /** Still above the budget after every collapse: the entry is uncacheable. */
  readonly overBudget: boolean;
  readonly softMaxAgeSeconds: number | null;
}

export function resolveCacheDependencies(input: CacheDepResolveInput): CacheDepResolution {
  const budget = input.budget ?? CACHE_DEP_ENTRY_KEY_BUDGET;
  const keys = new Set<string>(input.declared);
  keys.add(cacheDep.store());

  const declaredKinds = new Set<CacheDepKind>();
  for (const key of keys) {
    const kind = cacheDepKind(key);
    if (kind !== null) declaredKinds.add(kind);
  }

  const coarseTables: string[] = [];
  const softTables: string[] = [];
  const unregisteredTables: string[] = [];
  const rowKeyedStatements = [...(input.rowKeyedStatements ?? [])];
  for (const table of new Set(input.tables)) {
    const kinds = cacheDepKindsForTable(table);
    if (kinds !== null) {
      const tableKey = cacheDep.table(table);
      if (keys.has(tableKey)) continue;
      if (Object.prototype.hasOwnProperty.call(CACHE_DEP_ROW_KEYED_TABLES, table)) {
        if (rowKeyedTableCovered(table, rowKeyedStatements, keys)) continue;
      } else if (kinds.some((kind) => declaredKinds.has(kind))) {
        continue;
      }
      coarseTables.push(table);
      continue;
    }
    if (cacheDepExemptReason(table) !== null) {
      if (CACHE_DEP_SOFT_TABLES.has(table)) softTables.push(table);
      continue;
    }
    unregisteredTables.push(table);
  }
  for (const table of coarseTables) keys.add(cacheDep.table(table));

  const collapsedKinds: CacheDepKind[] = [];
  if (keys.size > budget) collapseToBudget(keys, budget, collapsedKinds);

  return {
    keys: [...keys].sort(),
    coarseTables: coarseTables.sort(),
    softTables: softTables.sort(),
    unregisteredTables: unregisteredTables.sort(),
    collapsedKinds,
    overBudget: keys.size > budget,
    softMaxAgeSeconds: null,
  };
}

/**
 * Replace the keys of the most numerous kinds by their coarse `t:` keys until
 * the set fits. Sound because every change of a registered table advances its
 * `t:` key, and a kind's keys are advanced only by tables that list the kind.
 */
function collapseToBudget(keys: Set<string>, budget: number, collapsed: CacheDepKind[]): void {
  const byKind = new Map<CacheDepKind, string[]>();
  for (const key of keys) {
    const kind = cacheDepKind(key);
    if (kind === null) continue;
    const group = byKind.get(kind) ?? [];
    group.push(key);
    byKind.set(kind, group);
  }
  const candidates = [...byKind.entries()]
    .filter(([kind, group]) => {
      const coarse = coarseKeysForKind(kind);
      return coarse.length > 0 && group.length > coarse.length;
    })
    .sort(([kindA, a], [kindB, b]) => b.length - a.length || kindA.localeCompare(kindB));
  for (const [kind, group] of candidates) {
    if (keys.size <= budget) return;
    for (const key of group) keys.delete(key);
    for (const key of coarseKeysForKind(kind)) keys.add(key);
    collapsed.push(kind);
  }
}
