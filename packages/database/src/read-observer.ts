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
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ReadObserver {
  /**
   * The distinct tables one statement touched, lower-case. The array is shared
   * and frozen: observers must copy what they keep and must not throw.
   */
  observeTables(tables: readonly string[]): void;
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

/**
 * Report one statement to the current observer. Transport hook: cheap when no
 * observer is active, never throws, never changes database behaviour.
 */
export function observeStatement(sql: string): void {
  const observer = observerStorage.getStore();
  if (observer === undefined) return;
  let tables: readonly string[];
  try {
    tables = statementTables(sql);
  } catch {
    // A parser failure is reported as an unknown table so it can never
    // silently narrow the dependency set.
    tables = UNPARSEABLE;
  }
  if (tables.length === 0) return;
  try {
    observer.observeTables(tables);
  } catch {
    // Diagnostics must never change database behaviour.
  }
}

/** The pseudo-table reported when a statement's tables cannot be determined. */
export const UNPARSEABLE_STATEMENT_TABLE = "(unparseable)";
const UNPARSEABLE: readonly string[] = Object.freeze([UNPARSEABLE_STATEMENT_TABLE]);
const NONE: readonly string[] = Object.freeze([]);

/**
 * Wrap a D1-shaped client so every `prepare(sql)` is observed. Drizzle's D1
 * session prepares every statement, batches included, through `prepare`.
 */
export function observeD1Prepare<T extends object>(client: T): T {
  const target = client as unknown as { prepare(query: string): unknown };
  const prepare = (query: string) => {
    observeStatement(query);
    return target.prepare(query);
  };
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
