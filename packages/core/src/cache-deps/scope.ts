/**
 * The request-scoped dependency recorder of the dependency-validated cache.
 *
 * `withDependencyScope(render)` runs one public render with a scope in its
 * async context (AsyncLocalStorage via `@scalius/database/read-observer`).
 * The database transports report every table the render touches; the readers
 * declare precise keys with `deps.*`; at close the scope resolves the entry's
 * key set (coverage fallback, soft max age, budget) and returns it with the
 * render's value. Concurrent scopes never see each other's reads. A nested
 * scope hands its resolved dependencies to its parent when it closes.
 */
import {
  currentReadObserver,
  runWithReadObserver,
  type ReadObserver,
} from "@scalius/database/read-observer";
import {
  CACHE_DEP_ENTRY_KEY_BUDGET,
  CACHE_DEP_ROW_KEYED_TABLES,
  cacheDepKind,
  isCacheDep,
  type CacheDepKind,
} from "@scalius/shared/cache-deps";

import { resolveCacheDependencies, type CacheDepRowKeyedStatement } from "./resolve";

const ROW_KEYED_TABLES: ReadonlySet<string> = new Set(Object.keys(CACHE_DEP_ROW_KEYED_TABLES));

/** What one cached entry depends on. */
export interface CacheDependencies {
  /** Sorted unique keys; always includes `store`. */
  readonly keys: readonly string[];
  /** Tables the render's statements touched (sorted). */
  readonly tables: readonly string[];
  /** Registered tables that fell back to their coarse `t:` key (sorted). */
  readonly coarseTables: readonly string[];
  /** Kinds the entry key budget collapsed to coarse `t:` keys. */
  readonly collapsedKinds: readonly CacheDepKind[];
  /**
   * Soft staleness bound in seconds (recommendation/popularity order), or null
   * when every dependency is hard. The entry may be served up to this age
   * after a soft change; hard keys still validate every hit.
   */
  readonly softMaxAgeSeconds: number | null;
  /** Epoch ms of the earliest scheduled transition read; never serve at or after it. */
  readonly validUntil: number | null;
  /** Why the entry must not be cached; empty when it may be. */
  readonly uncacheable: readonly string[];
}

export interface DependencyScopeOptions {
  /** Route label for log lines, e.g. `/api/v1/products/:slug`. The query is dropped. */
  readonly label?: string;
  /**
   * Throw `CacheDepCoverageError` instead of falling back (coverage tests).
   * Nested scopes inherit it from their parent scope.
   */
  readonly strict?: boolean;
  /** Entry key budget; defaults to `CACHE_DEP_ENTRY_KEY_BUDGET`. */
  readonly budget?: number;
  /** Log sink for coarse/uncacheable lines; defaults to `console.warn`. */
  readonly log?: (line: string) => void;
}

export interface DependencyScopeResult<T> {
  readonly value: T;
  readonly dependencies: CacheDependencies;
}

/** A strict scope read a table no declared key covers (or an unregistered one). */
export class CacheDepCoverageError extends Error {
  constructor(
    readonly label: string,
    readonly coarseTables: readonly string[],
    readonly unregisteredTables: readonly string[],
    readonly invalidKeys: readonly string[] = [],
  ) {
    const parts = [
      coarseTables.length > 0 ? `uncovered tables ${coarseTables.join(", ")}` : "",
      unregisteredTables.length > 0 ? `unregistered tables ${unregisteredTables.join(", ")}` : "",
      invalidKeys.length > 0 ? `invalid keys ${invalidKeys.join(", ")}` : "",
    ].filter(Boolean);
    super(`[CacheDeps] ${label}: ${parts.join("; ")}`);
    this.name = "CacheDepCoverageError";
  }
}

const MAX_LABEL_LENGTH = 120;

/** Route-shaped label only: no query, fragment or whitespace ever reaches a log line. */
function maskLabel(label: string | undefined): string {
  if (!label) return "(unlabelled)";
  const path = label.split(/[?#]/, 1)[0]!.replace(/\s+/g, "_");
  return path.length > MAX_LABEL_LENGTH ? `${path.slice(0, MAX_LABEL_LENGTH)}...` : path || "(unlabelled)";
}

export class DependencyScope implements ReadObserver {
  readonly label: string;
  readonly strict: boolean;
  private readonly declared = new Set<string>();
  private readonly tables = new Set<string>();
  /** Bound statements that read a row-keyed table (settings). */
  private readonly rowKeyedStatements: CacheDepRowKeyedStatement[] = [];
  /** The transports report the SQL and parameters of statements touching these tables. */
  readonly valueTables: ReadonlySet<string> = ROW_KEYED_TABLES;
  private readonly invalidKeys: string[] = [];
  private readonly uncacheableReasons: string[] = [];
  private softMaxAgeSeconds: number | null = null;
  private validUntilMs: number | null = null;
  private closed = false;

  constructor(
    readonly parent: ReadObserver | undefined,
    options: DependencyScopeOptions,
  ) {
    this.label = maskLabel(options.label);
    this.strict = options.strict
      ?? (parent instanceof DependencyScope ? parent.strict : false);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  observeTables(tables: readonly string[]): void {
    if (this.closed) return;
    for (let index = 0; index < tables.length; index += 1) this.tables.add(tables[index]!);
    // A non-scope observer around this scope (a test harness) still sees reads.
    if (this.parent !== undefined && !(this.parent instanceof DependencyScope)) {
      this.parent.observeTables(tables);
    }
  }

  observeBoundStatement(tables: readonly string[], sql: string, params: readonly unknown[]): void {
    if (this.closed) return;
    this.rowKeyedStatements.push({ tables: [...tables], sql, params: [...params] });
  }

  declare(key: string): void {
    if (this.closed) return;
    if (this.declared.has(key)) return;
    if (!isCacheDep(key)) {
      if (this.strict) throw new CacheDepCoverageError(this.label, [], [], [key]);
      this.invalidKeys.push(cacheDepKind(key) ?? "(unknown kind)");
      return;
    }
    this.declared.add(key);
  }

  softMaxAge(seconds: number): void {
    if (this.closed || !Number.isFinite(seconds) || seconds < 0) return;
    this.softMaxAgeSeconds = this.softMaxAgeSeconds === null
      ? seconds
      : Math.min(this.softMaxAgeSeconds, seconds);
  }

  validUntil(epochMs: number): void {
    if (this.closed || !Number.isFinite(epochMs)) return;
    this.validUntilMs = this.validUntilMs === null ? epochMs : Math.min(this.validUntilMs, epochMs);
  }

  uncacheable(reason: string): void {
    if (this.closed) return;
    if (!this.uncacheableReasons.includes(reason)) this.uncacheableReasons.push(reason);
  }

  /** A closed child scope's result becomes part of this entry. */
  absorb(child: CacheDependencies): void {
    if (this.closed) return;
    for (const key of child.keys) this.declared.add(key);
    if (child.softMaxAgeSeconds !== null) this.softMaxAge(child.softMaxAgeSeconds);
    if (child.validUntil !== null) this.validUntil(child.validUntil);
    for (const reason of child.uncacheable) this.uncacheable(reason);
  }

  /** Resolve the entry's dependencies. Idempotent state change: the scope stops recording. */
  close(budget: number, log: (line: string) => void): CacheDependencies {
    this.closed = true;
    const resolution = resolveCacheDependencies({
      declared: this.declared,
      tables: this.tables,
      rowKeyedStatements: this.rowKeyedStatements,
      budget,
    });
    if (this.strict && (resolution.coarseTables.length > 0 || resolution.unregisteredTables.length > 0)) {
      throw new CacheDepCoverageError(this.label, resolution.coarseTables, resolution.unregisteredTables);
    }

    const uncacheable = [...this.uncacheableReasons];
    for (const table of resolution.unregisteredTables) uncacheable.push(`unregistered-table:${table}`);
    if (resolution.overBudget) uncacheable.push("over-budget");

    if (resolution.coarseTables.length > 0) {
      log(`[CacheDeps] coarse ${this.label} ${resolution.coarseTables.join(",")}`);
    }
    if (resolution.unregisteredTables.length > 0) {
      log(`[CacheDeps] uncacheable ${this.label} unregistered ${resolution.unregisteredTables.join(",")}`);
    }
    if (resolution.collapsedKinds.length > 0) {
      log(`[CacheDeps] budget ${this.label} collapsed ${resolution.collapsedKinds.join(",")}`);
    }
    if (this.invalidKeys.length > 0) {
      log(`[CacheDeps] invalid-key ${this.label} ${[...new Set(this.invalidKeys)].join(",")}`);
    }

    const soft = [this.softMaxAgeSeconds, resolution.softMaxAgeSeconds]
      .filter((value): value is number => value !== null);
    return {
      keys: resolution.keys,
      tables: [...this.tables].sort(),
      coarseTables: resolution.coarseTables,
      collapsedKinds: resolution.collapsedKinds,
      softMaxAgeSeconds: soft.length > 0 ? Math.min(...soft) : null,
      validUntil: this.validUntilMs,
      uncacheable,
    };
  }
}

const defaultLog = (line: string): void => {
  console.warn(line);
};

/**
 * Run one public render and record what its output depends on.
 *
 * The render's value and its dependencies are returned together. When the
 * render throws, the scope closes without a result and the error propagates.
 * A strict scope throws `CacheDepCoverageError` after the render if a table
 * was not covered by a declared key.
 */
export async function withDependencyScope<T>(
  render: () => T | Promise<T>,
  options: DependencyScopeOptions = {},
): Promise<DependencyScopeResult<T>> {
  const parent = currentReadObserver();
  const scope = new DependencyScope(parent, options);
  let value: T;
  try {
    value = await runWithReadObserver(scope, render);
  } catch (error) {
    // Close so late reads stop recording; the result is discarded. A parent
    // that swallows this error must not cache whatever it renders instead.
    try {
      scope.close(options.budget ?? CACHE_DEP_ENTRY_KEY_BUDGET, () => undefined);
    } catch {
      // The render's own error is the one that matters.
    }
    if (parent instanceof DependencyScope) parent.uncacheable("nested-render-failed");
    throw error;
  }
  const dependencies = scope.close(options.budget ?? CACHE_DEP_ENTRY_KEY_BUDGET, options.log ?? defaultLog);
  if (parent instanceof DependencyScope) parent.absorb(dependencies);
  return { value, dependencies };
}

/** The dependency scope of the current async context, or null. */
export function activeDependencyScope(): DependencyScope | null {
  const observer = currentReadObserver();
  return observer instanceof DependencyScope && !observer.isClosed ? observer : null;
}
