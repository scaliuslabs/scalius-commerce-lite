/**
 * Read observation for the dependency-validated public cache (DVC).
 *
 * Every provider transport (the D1 request client, the Turso adapter and the
 * PostgreSQL adapter) reports the SQL text of each statement it sends through
 * `observeStatement`. When an async context runs under `runWithReadObserver`,
 * the observer receives the tables the statement touched; otherwise the call
 * is one `AsyncLocalStorage.getStore()` and returns.
 *
 * The observer is request-scoped (AsyncLocalStorage), never a module global:
 * concurrent requests and concurrent batch parts inside one invocation each
 * see only their own reads. `@scalius/core/cache-deps` builds its dependency
 * scope on this hook.
 *
 * Table extraction is syntactic and deliberately conservative. It reports the
 * table after every `FROM` and `JOIN` (quoted or bare, schema-qualified or not)
 * and the target of an `INSERT`/`REPLACE`/`UPDATE`, and it skips
 * table-valued functions (`json_each(...)`), subqueries and CTE names.
 * Over-reporting a table costs hit rate at worst; the coverage check turns an
 * unexplained table into a coarse or uncacheable entry, never a stale one.
 *
 * Tables read by row identity (settings documents) need more than the table
 * name: an observer that lists them in `valueTables` also receives each bound
 * execution's SQL and parameters, and `pinnedSourceValues` says which rows
 * the statement pinned.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ReadObserver {
  /**
   * The distinct tables one statement touched, lower-case. The array is shared
   * and frozen: observers must copy what they keep and must not throw.
   */
  observeTables(tables: readonly string[]): void;
  /**
   * Tables read by row identity: for a statement touching one of them the
   * transport also reports the statement's SQL and bound parameters (see
   * `observeBoundStatement`). Read once per statement; keep it small.
   */
  readonly valueTables?: ReadonlySet<string>;
  /**
   * One execution of a statement that touched a value table: its tables, its
   * SQL and its bound parameters (see `pinnedSourceValues`). D1 binds after
   * `prepare`, so this arrives at `bind` time, once per binding.
   */
  observeBoundStatement?(tables: readonly string[], sql: string, params: readonly unknown[]): void;
}

const observerStorage = new AsyncLocalStorage<ReadObserver>();

/** Run `callback` with `observer` receiving every statement its async context sends. */
export function runWithReadObserver<T>(observer: ReadObserver, callback: () => T): T {
  return observerStorage.run(observer, callback);
}

/** The observer of the current async context, if any. */
export function currentReadObserver(): ReadObserver | undefined {
  return observerStorage.getStore();
}

/** The observer and tables of a statement the observer wants bound values for. */
interface PendingBinding {
  readonly observer: ReadObserver;
  readonly tables: readonly string[];
}

function observeTablesOf(sql: string): { observer: ReadObserver; tables: readonly string[] } | undefined {
  const observer = observerStorage.getStore();
  if (observer === undefined) return undefined;
  let tables: readonly string[];
  try {
    tables = statementTables(sql);
  } catch {
    // A parser failure is reported as an unknown table so it can never
    // silently narrow the dependency set.
    tables = UNPARSEABLE;
  }
  if (tables.length === 0) return undefined;
  try {
    observer.observeTables(tables);
  } catch {
    // Diagnostics must never change database behaviour.
  }
  return { observer, tables };
}

function wantsBinding(observer: ReadObserver, tables: readonly string[]): boolean {
  const valueTables = observer.valueTables;
  return valueTables !== undefined && observer.observeBoundStatement !== undefined
    && tables.some((table) => valueTables.has(table));
}

function reportBinding(pending: PendingBinding, sql: string, params: readonly unknown[]): void {
  try {
    pending.observer.observeBoundStatement!(pending.tables, sql, params);
  } catch {
    // Diagnostics must never change database behaviour.
  }
}

/**
 * Report one statement to the current observer, with its bound parameters.
 * Transport hook for transports that bind with the statement (Turso,
 * PostgreSQL): cheap when no observer is active, never throws, never changes
 * database behaviour.
 */
export function observeStatement(sql: string, params: readonly unknown[] = []): void {
  const seen = observeTablesOf(sql);
  if (seen === undefined || !wantsBinding(seen.observer, seen.tables)) return;
  reportBinding({ observer: seen.observer, tables: seen.tables }, sql, params);
}

/**
 * A D1 prepared statement whose `bind(...)` reports the bound execution to
 * the observer of its `prepare`. Every other member is the statement's own,
 * bound to it.
 */
function observeD1Bind<T extends object>(statement: T, sql: string, pending: PendingBinding): T {
  const target = statement as unknown as { bind(...params: unknown[]): unknown };
  const bind = (...params: unknown[]) => {
    reportBinding(pending, sql, params);
    return target.bind(...params);
  };
  return new Proxy(statement, {
    get(object, property) {
      if (property === "bind") return bind;
      const value = Reflect.get(object, property, object) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
    },
  });
}

/**
 * Observe one D1 `prepare(sql)`: report its tables, and when the observer
 * reads one of them by row identity, report each binding of the statement
 * (at once when the statement has no placeholder to bind).
 */
export function observeD1Statement<T extends object>(query: string, prepare: (query: string) => T): T {
  const seen = observeTablesOf(query);
  const statement = prepare(query);
  if (seen === undefined || !wantsBinding(seen.observer, seen.tables)) return statement;
  const pending = { observer: seen.observer, tables: seen.tables };
  if (!/\?/.test(query.replace(STRING_LITERAL, "''"))) {
    reportBinding(pending, query, []);
    return statement;
  }
  return observeD1Bind(statement, query, pending);
}

// ---------------------------------------------------------------------------
// Row attribution
// ---------------------------------------------------------------------------

/**
 * For each `FROM`/`JOIN` source of `table` in one SQLite-dialect statement,
 * the values its predicate pins each of `columns` to: `col = v` or
 * `col IN (v, ...)`, where v is a string literal or a `?` placeholder read
 * from `params`, and `col` is bare or qualified by the table or its alias.
 * A column the source's predicate does not pin that way is `null`.
 *
 * The predicate searched is the rest of the source's own query level (up to
 * the parenthesis that closes it). This is attribution for dependency
 * coverage and errs toward "not pinned": a source it cannot attribute makes
 * the read uncovered (a coarse key), never a narrower one. An `OR` between a
 * pinned column and another condition on the same source is the one shape it
 * would over-trust; no generated or hand-written read uses it.
 */
export function pinnedSourceValues(
  sql: string,
  params: readonly unknown[],
  table: string,
  columns: readonly string[],
): Array<Record<string, string[] | null>> {
  // Same-length masks: literals keep their quotes (their text becomes 'x'),
  // comments become spaces, so offsets agree across the three strings.
  const literals = new Map<number, string>();
  let masked = sql.replace(STRING_LITERAL, (match, offset: number) => {
    literals.set(offset, match.slice(1, -1).replace(/''/g, "'"));
    return `'${"x".repeat(match.length - 2)}'`;
  });
  masked = masked.replace(LINE_COMMENT, (match) => " ".repeat(match.length))
    .replace(BLOCK_COMMENT, (match) => " ".repeat(match.length));
  const placeholders = new Map<number, number>();
  for (let index = 0, count = 0; index < masked.length; index += 1) {
    if (masked[index] === "'") {
      index = masked.indexOf("'", index + 1);
      if (index === -1) break;
      continue;
    }
    if (masked[index] === "?") placeholders.set(index, count++);
  }
  const valueAt = (offset: number): string | null => {
    if (masked[offset] === "?") {
      const param = params[placeholders.get(offset) ?? -1];
      return typeof param === "string" || typeof param === "number" || typeof param === "bigint" ? String(param) : null;
    }
    if (masked[offset] === "'") return literals.get(offset) ?? null;
    return null;
  };

  const results: Array<Record<string, string[] | null>> = [];
  const quoted = `(?:"${table}"|\\x60${table}\\x60|\\[${table}\\]|${table})`;
  const source = new RegExp(`(?<![."\\x60\\[\\w])\\b(?:from|join)\\s+(?:main\\s*\\.\\s*)?${quoted}(?![\\w"\\x60\\]])(?:\\s+(?:as\\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?))?`, "gi");
  for (const match of masked.matchAll(source)) {
    const aliasRaw = match[1];
    const alias = aliasRaw && !SOURCE_KEYWORDS.has(aliasRaw.replace(/"/g, "").toLowerCase())
      ? aliasRaw.replace(/"/g, "")
      : null;
    // The rest of this source's query level.
    const start = match.index! + match[0].length - (alias === null && aliasRaw ? aliasRaw.length : 0);
    let end = masked.length;
    for (let index = start, depth = 0; index < masked.length; index += 1) {
      const char = masked[index];
      if (char === "(") depth += 1;
      else if (char === ")") {
        if (depth === 0) {
          end = index;
          break;
        }
        depth -= 1;
      }
    }
    const segment = masked.slice(start, end);
    const qualifiers = [table, ...(alias ? [alias] : [])].map((name) => `(?:"${name}"|\\x60${name}\\x60|${name})`).join("|");
    const pinned: Record<string, string[] | null> = {};
    for (const column of columns) {
      const comparison = new RegExp(
        `(?<![\\w."\\x60])(?:(?:${qualifiers})\\s*\\.\\s*)?(?:"${column}"|\\x60${column}\\x60|\\b${column}\\b)\\s*(?:(=)|\\b(in)\\b)\\s*`,
        "gi",
      );
      const values: string[] = [];
      let unresolved = false;
      for (const found of segment.matchAll(comparison)) {
        const offset = start + found.index! + found[0].length;
        if (found[1] === "=") {
          const value = valueAt(offset);
          if (value === null) unresolved = true;
          else values.push(value);
          continue;
        }
        const close = masked[offset] === "(" ? masked.indexOf(")", offset) : -1;
        if (close === -1) {
          unresolved = true;
          continue;
        }
        // `IN (v, ...)`: every item a literal or a placeholder.
        for (const item of masked.slice(offset + 1, close).matchAll(/[^,]+/g)) {
          const lead = item[0].length - item[0].trimStart().length;
          const value = valueAt(offset + 1 + item.index! + lead);
          if (value === null) unresolved = true;
          else values.push(value);
        }
      }
      pinned[column] = unresolved || values.length === 0 ? null : [...new Set(values)];
    }
    results.push(pinned);
  }
  return results;
}

/** Words that can follow a source without being its alias. */
const SOURCE_KEYWORDS = new Set([
  "where", "join", "inner", "left", "right", "full", "cross", "outer", "natural", "on", "using",
  "group", "order", "limit", "offset", "union", "except", "intersect", "window", "having", "returning", "set", "values",
]);


/** The pseudo-table reported when a statement's tables cannot be determined. */
export const UNPARSEABLE_STATEMENT_TABLE = "(unparseable)";
const UNPARSEABLE: readonly string[] = Object.freeze([UNPARSEABLE_STATEMENT_TABLE]);
const NONE: readonly string[] = Object.freeze([]);

/**
 * Wrap a D1-shaped client so every `prepare(sql)` is observed. Drizzle's D1
 * session prepares every statement, batches included, through `prepare`.
 */
export function observeD1Prepare<T extends object>(client: T): T {
  const target = client as unknown as { prepare(query: string): object };
  const prepare = (query: string) => observeD1Statement(query, (sql) => target.prepare(sql));
  return new Proxy(client, {
    get(object, property, receiver) {
      if (property === "prepare") return prepare;
      return Reflect.get(object, property, receiver);
    },
  });
}

// ---------------------------------------------------------------------------
// Table extraction
// ---------------------------------------------------------------------------

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;

/**
 * `FROM x`, `JOIN x`, `FROM main.x`; group 3 is the part after a dot, group 4
 * an opening parenthesis (a table-valued function). Not after a quote or dot
 * (a column literally named "from") and not in `IS [NOT] DISTINCT FROM`.
 */
const SOURCE_PATTERN = new RegExp(
  String.raw`(?<![."\x60\[])(?<!\bdistinct\s+)\b(from|join)\b\s*(${IDENT})(?:\s*\.\s*(${IDENT}))?(\s*\()?`,
  "gi",
);
const WRITE_TARGET_PATTERN = new RegExp(
  String.raw`^\s*(?:(?:insert|replace)(?:\s+or\s+[a-z]+)?\s+into|update(?:\s+or\s+[a-z]+)?)\s+(${IDENT})(?:\s*\.\s*(${IDENT}))?`,
  "i",
);
const CTE_PATTERN = new RegExp(
  String.raw`(?:\bwith(?:\s+recursive)?|,)\s*(${IDENT})\s*(?:\([^()]*\)\s*)?\bas\s+(?:not\s+)?(?:materialized\s+)?\(`,
  "gi",
);
/** `, y` after a FROM source (with an optional alias): a comma join. */
const COMMA_SOURCE_PATTERN = new RegExp(
  String.raw`\s*(?:as\s+)?(?:${IDENT})?\s*,\s*(${IDENT})(?:\s*\.\s*(${IDENT}))?(\s*\()?`,
  "iy",
);
const STRING_LITERAL = /'(?:[^']|'')*'/g;
const LINE_COMMENT = /--[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

/** Bare words that can follow FROM/JOIN without naming a table. */
const NOT_TABLES = new Set(["select", "values", "lateral", "only"]);

function identifierName(raw: string): string {
  const first = raw.charCodeAt(0);
  if (first === 34 /* " */) return raw.slice(1, -1).replace(/""/g, "\"").toLowerCase();
  if (first === 96 /* ` */ || first === 91 /* [ */) return raw.slice(1, -1).toLowerCase();
  return raw.toLowerCase();
}

/**
 * Memo of pure parse results for statements without string literals
 * (Drizzle binds every value, so its SQL text carries only identifiers).
 * Statements with literals are parsed every time so no literal value is
 * retained across requests. Bounded; cleared when full.
 */
const TABLE_MEMO = new Map<string, readonly string[]>();
const TABLE_MEMO_LIMIT = 1024;

/** The distinct lower-case tables a SQLite-dialect statement touches. */
export function statementTables(sql: string): readonly string[] {
  const memoizable = sql.indexOf("'") === -1;
  if (memoizable) {
    const cached = TABLE_MEMO.get(sql);
    if (cached !== undefined) return cached;
  }
  const tables = parseStatementTables(sql);
  if (memoizable) {
    if (TABLE_MEMO.size >= TABLE_MEMO_LIMIT) TABLE_MEMO.clear();
    TABLE_MEMO.set(sql, tables);
  }
  return tables;
}

function parseStatementTables(input: string): readonly string[] {
  let sql = input;
  if (sql.indexOf("'") !== -1) sql = sql.replace(STRING_LITERAL, "''");
  if (sql.indexOf("--") !== -1) sql = sql.replace(LINE_COMMENT, " ");
  if (sql.indexOf("/*") !== -1) sql = sql.replace(BLOCK_COMMENT, " ");

  const tables: string[] = [];
  const add = (name: string) => {
    if (!tables.includes(name)) tables.push(name);
  };

  const write = WRITE_TARGET_PATTERN.exec(sql);
  if (write) add(identifierName(write[2] ?? write[1]!));

  let cteNames: string[] | null = null;
  if (/\bwith\b/i.test(sql)) {
    cteNames = [];
    for (const match of sql.matchAll(CTE_PATTERN)) cteNames.push(identifierName(match[1]!));
  }

  const addSource = (raw: string, qualified: boolean) => {
    const first = raw.charCodeAt(0);
    const bare = !qualified && first !== 34 && first !== 96 && first !== 91;
    const name = identifierName(raw);
    if (bare && NOT_TABLES.has(name)) return;
    if (cteNames !== null && cteNames.includes(name)) return;
    add(name);
  };

  for (const match of sql.matchAll(SOURCE_PATTERN)) {
    if (match[4] !== undefined) continue; // a table-valued function: json_each(...)
    addSource(match[3] ?? match[2]!, match[3] !== undefined);
    // `FROM a [alias], b [alias], ...`
    COMMA_SOURCE_PATTERN.lastIndex = match.index + match[0].length;
    for (let next = COMMA_SOURCE_PATTERN.exec(sql); next !== null; next = COMMA_SOURCE_PATTERN.exec(sql)) {
      if (next[3] === undefined) addSource(next[2] ?? next[1]!, next[2] !== undefined);
    }
  }
  return tables.length === 0 ? NONE : Object.freeze(tables);
}
