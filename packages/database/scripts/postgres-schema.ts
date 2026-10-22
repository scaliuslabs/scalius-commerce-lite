import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  compileSqliteNullSafeComparisons,
  POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL,
} from "../src/postgres-sqlite-profile";
import type { SqliteTriggerDefinition } from "../src/migration-artifacts";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
  readFinalTriggerDefinitions,
} from "./sqlite-provider-schema";
import {
  CACHE_DEP_POSTGRES_BUMP_FUNCTION,
  CACHE_DEP_POSTGRES_LOG_SQL,
  cacheDepPostgresTrigger,
} from "./cache-dep-triggers";
import { eventOutboxPostgresTrigger } from "./event-outbox-triggers";
import { eventDemandPostgresTrigger } from "./event-demand-triggers";
import { conversationSearchPostgresCollation } from "./conversation-workspace";
import {
  SEARCH_INDEX_TABLE,
  SEARCH_INDEX_TABLE_STATEMENTS,
  searchIndexRebuildStatements,
  searchIndexTriggers,
} from "../src/search-index";

export const POSTGRES_SCHEMA_BUNDLE_VERSION =
  "scalius-postgres-schema/v1" as const;

/** Run after loading historical orders; never rewind a sequence on migration replay. */
export const POSTGRES_ORDER_NUMBER_SEQUENCE_SQL = [
  `LOCK TABLE "orders" IN ACCESS EXCLUSIVE MODE;`,
  `CREATE SEQUENCE IF NOT EXISTS scalius_compat.order_number_seq AS bigint MINVALUE 1001 MAXVALUE 9007199254740991 START WITH 1001;`,
  `SELECT setval('scalius_compat.order_number_seq', GREATEST(
    (SELECT coalesce(max("order_number"), 1000) + 1 FROM "orders"),
    (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM scalius_compat.order_number_seq)
  ), false);`,
] as const;

interface SqliteSchemaObject {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

export interface PostgresSchemaBundle {
  version: typeof POSTGRES_SCHEMA_BUNDLE_VERSION;
  preDataSql: string;
  postDataSql: string;
  sql: string;
  sha256: string;
  applicationTables: number;
  /** Derived tables post-data creates and rebuilds from the loaded rows (the search index). */
  derivedTables: number;
  indexes: number;
  triggers: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function unquoteIdentifier(identifier: string): string {
  const value = identifier.trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("`") && value.endsWith("`"))
    || (value.startsWith("[") && value.endsWith("]"))
  ) {
    return value.slice(1, -1).replaceAll(value[0]!, value[0]!);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`Invalid SQLite identifier ${JSON.stringify(identifier)}.`);
  }
  return value;
}

/** SQLite GLOB pattern text to an anchored POSIX regex (GLOB is case-sensitive, as is `~`). */
export function globToPostgresRegex(pattern: string): string {
  // The common shape `*[class]*` ("contains a character of the class") stays
  // the short unanchored class, as every sidecar already writes it.
  const contains = /^\*(\[[^\]]+\])\*$/.exec(pattern);
  if (contains) return contains[1]!;
  let regex = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") regex += ".*";
    else if (character === "?") regex += ".";
    else if (character === "[") {
      const close = pattern.indexOf("]", index + 2);
      if (close === -1) {
        regex += "\\[";
        continue;
      }
      regex += pattern.slice(index, close + 1);
      index = close;
    } else regex += /[.+(){}|\\$^]/.test(character) ? `\\${character}` : character;
  }
  return `${regex}$`;
}

function compileGlobPatterns(sql: string): string {
  return sql.replace(
    /\b(NOT\s+)?GLOB\s+'((?:[^']|'')*)'/gi,
    (_match, not: string | undefined, pattern: string) =>
      `${not ? "!~" : "~"} '${globToPostgresRegex(pattern.replaceAll("''", "'")).replaceAll("'", "''")}'`,
  );
}

function compileNumericJsonChecks(sql: string): string {
  return sql.replace(
    /json_extract\(([^,]+),\s*('\$\.(?:amountMinor|basisPoints|quantity)')\)\s+BETWEEN/gi,
    "CAST(json_extract($1, $2) AS bigint) BETWEEN",
  );
}

function compileInstrCalls(sql: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < sql.length) {
    const match = /\binstr\s*\(/iy;
    match.lastIndex = cursor;
    const found = match.exec(sql);
    if (!found) {
      output += sql[cursor]!;
      cursor += 1;
      continue;
    }
    const open = match.lastIndex - 1;
    let end = open + 1;
    let depth = 1;
    let comma = -1;
    let quote: "'" | '"' | "`" | null = null;
    while (end < sql.length && depth > 0) {
      const character = sql[end]!;
      if (quote) {
        if (character === quote) {
          if (sql[end + 1] === quote) end += 2;
          else {
            quote = null;
            end += 1;
          }
        } else end += 1;
        continue;
      }
      if (character === "'" || character === '"' || character === "`") {
        quote = character;
        end += 1;
        continue;
      }
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 1 && comma < 0) comma = end;
      end += 1;
    }
    if (depth !== 0 || comma < 0) {
      throw new Error("Unsupported SQLite instr() expression.");
    }
    const close = end - 1;
    const haystack = compileInstrCalls(sql.slice(open + 1, comma).trim());
    const needle = compileInstrCalls(sql.slice(comma + 1, close).trim());
    output += `position(${needle} in ${haystack})`;
    cursor = end;
  }
  return output;
}

/** From this migration PostgreSQL text compares bytewise and the dependency clock is a change log. */
export const POSTGRES_SCALE_MIGRATION = "0151_postgres_scale";

/**
 * SQLite compares text bytewise (BINARY); PostgreSQL under a locale such as
 * en_US orders `prod_aB` and `prod_Ab` (or `-` and `_`) differently, so ties
 * broken by text ids, keyset cursors and ranges disagreed between providers.
 * From 0151 every PostgreSQL text column is `COLLATE "C"`: one byte order
 * on every provider, and cheaper comparisons than a locale's.
 */
export function collatePostgresTextColumns(ddl: string): string {
  if (!/^\s*CREATE\s+TABLE\b/i.test(ddl)) return ddl;
  return ddl.replace(/([(,]\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\s+text)(?=[\s,)])(?!\s+COLLATE\b)/gi, '$1 COLLATE "C"');
}

/**
 * 0151 on an existing PostgreSQL store: every public text column becomes
 * `COLLATE "C"`. A column a trigger's WHEN names cannot change type, so every
 * trigger is dropped and recreated from its own definition around it.
 */
export const POSTGRES_TEXT_COLLATION_SQL = `DO $collate_text$
DECLARE
  item record;
  triggers text[] := ARRAY[]::text[];
  definition text;
BEGIN
  FOR item IN
    SELECT t.tgname, t.tgrelid::regclass AS relation, pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace
    ORDER BY t.oid
  LOOP
    triggers := triggers || item.definition;
    EXECUTE format('DROP TRIGGER %I ON %s', item.tgname, item.relation);
  END LOOP;
  FOR item IN
    SELECT a.attrelid::regclass AS relation,
      string_agg(format('ALTER COLUMN %I TYPE text COLLATE "C"', a.attname), ', ' ORDER BY a.attnum) AS changes
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid = 'text'::regtype AND a.attcollation <> '"C"'::regcollation
    GROUP BY a.attrelid
  LOOP
    EXECUTE format('ALTER TABLE %s %s', item.relation, item.changes);
  END LOOP;
  FOREACH definition IN ARRAY triggers LOOP
    EXECUTE definition;
  END LOOP;
END
$collate_text$`;

/** Compile trusted canonical SQLite DDL/body SQL into the Postgres profile. */
export function compileSqliteDdlForPostgres(sql: string): string {
  let source = compileSqliteNullSafeComparisons(
    compileInstrCalls(compileNumericJsonChecks(compileGlobPatterns(sql))),
  )
    .replace(/\)\s+WITHOUT\s+ROWID\b/gi, ")")
    .replace(/\bAUTOINCREMENT\b/gi, "")
    .replace(
      /(ON\s+DELETE\s+(?:NO\s+ACTION|SET\s+NULL|CASCADE|RESTRICT))(?=\s*[,)]|\s*\n)/gi,
      "$1 DEFERRABLE INITIALLY DEFERRED",
    )
    // SQLite accepts integer 0 as the fallback for a boolean CHECK. This
    // exact doubled-close shape is used only by the two JSON shape checks;
    // numeric COALESCE expressions continue with arithmetic instead.
    .replace(/\),\s*0\)\s*\)/g, "), false))");
  let output = "";
  let cursor = 0;
  let state: "normal" | "single" | "double" | "line" | "block" = "normal";

  while (cursor < source.length) {
    const character = source[cursor]!;
    if (state === "single") {
      output += character;
      cursor += 1;
      if (character === "'" && source[cursor] === "'") {
        output += "'";
        cursor += 1;
      } else if (character === "'") state = "normal";
      continue;
    }
    if (state === "double") {
      output += character;
      cursor += 1;
      if (character === '"' && source[cursor] === '"') {
        output += '"';
        cursor += 1;
      } else if (character === '"') state = "normal";
      continue;
    }
    if (state === "line") {
      output += character;
      cursor += 1;
      if (character === "\n") state = "normal";
      continue;
    }
    if (state === "block") {
      output += character;
      cursor += 1;
      if (character === "*" && source[cursor] === "/") {
        output += "/";
        cursor += 1;
        state = "normal";
      }
      continue;
    }
    if (character === "'") {
      output += character;
      cursor += 1;
      state = "single";
      continue;
    }
    if (character === '"') {
      output += character;
      cursor += 1;
      state = "double";
      continue;
    }
    if (character === "-" && source[cursor + 1] === "-") {
      output += "--";
      cursor += 2;
      state = "line";
      continue;
    }
    if (character === "/" && source[cursor + 1] === "*") {
      output += "/*";
      cursor += 2;
      state = "block";
      continue;
    }
    if (character === "`" || character === "[") {
      const closing = character === "[" ? "]" : "`";
      let end = cursor + 1;
      let identifier = "";
      while (end < source.length && source[end] !== closing) {
        identifier += source[end]!;
        end += 1;
      }
      if (end >= source.length) throw new Error("Unterminated SQLite DDL identifier.");
      output += quoteIdentifier(identifier);
      cursor = end + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = cursor + 1;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) end += 1;
      const word = source.slice(cursor, end);
      const normalized = word.toLowerCase();
      const followedByCall = /^\s*\(/.test(source.slice(end));
      if (normalized === "integer" || normalized === "int") output += "bigint";
      else if (normalized === "real") output += "double precision";
      else if (normalized === "blob") output += "bytea";
      else if (normalized === "char" && followedByCall) output += "chr";
      else if (normalized === "true") output += "1";
      else if (normalized === "false") output += "0";
      else if (normalized === "json" && followedByCall) {
        output += "scalius_compat.json_text";
      }
      else output += word;
      cursor = end;
      continue;
    }
    output += character;
    cursor += 1;
  }
  if (state !== "normal" && state !== "line") {
    throw new Error("Unterminated SQLite DDL literal or comment.");
  }
  return conversationSearchPostgresCollation(aliasDerivedTables(output.replace(/\),\s*0\)\s*\)/g, "), false))")));
}

/** Words that may follow a derived table without being its alias. */
const DERIVED_TABLE_FOLLOWERS = new Set([
  "where", "group", "order", "limit", "offset", "union", "except", "intersect", "join", "inner", "left",
  "right", "full", "cross", "natural", "on", "using", "having", "window", "returning", "for", "then",
  "else", "end", "when", "and", "or",
]);

/** The index just past the quoted run that starts at `start` (a doubled quote is part of it). */
function quotedRunEnd(sql: string, start: number): number {
  const quote = sql[start];
  let cursor = start + 1;
  while (cursor < sql.length) {
    if (sql[cursor] === quote) {
      if (sql[cursor + 1] === quote) cursor += 2;
      else return cursor + 1;
    } else cursor += 1;
  }
  return sql.length;
}

/**
 * Names every unnamed derived table (`FROM (SELECT ...)`, `JOIN (SELECT ...)`)
 * of compiled PostgreSQL SQL. SQLite and PostgreSQL 16+ accept one without an
 * alias; PostgreSQL 15 and older reject it ("subquery in FROM must have an
 * alias"), at parse time for DDL and at first execution inside a trigger
 * function, so one compiled form must carry the name to run on every
 * supported server.
 */
export function aliasDerivedTables(sql: string): string {
  const open: boolean[] = [];
  let output = "";
  let cursor = 0;
  // The last two tokens: `IS [NOT] DISTINCT FROM (SELECT ...)` compares, it reads no table.
  let previous = "";
  let earlier = "";
  const remember = (token: string) => {
    earlier = previous;
    previous = token;
  };
  let aliases = 0;
  while (cursor < sql.length) {
    const character = sql[cursor]!;
    if (character === "'" || character === '"') {
      const end = quotedRunEnd(sql, cursor);
      output += sql.slice(cursor, end);
      cursor = end;
      remember(character);
      continue;
    }
    if ((character === "-" && sql[cursor + 1] === "-") || (character === "/" && sql[cursor + 1] === "*")) {
      const close = character === "-" ? sql.indexOf("\n", cursor) : sql.indexOf("*/", cursor + 2);
      const end = close === -1 ? sql.length : character === "-" ? close : close + 2;
      output += sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      let end = cursor + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end += 1;
      remember(sql.slice(cursor, end).toLowerCase());
      output += sql.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (character === "(") {
      const first = /^\s*([A-Za-z_]+)/.exec(sql.slice(cursor + 1))?.[1]?.toLowerCase();
      const tableClause = previous === "join" || (previous === "from" && earlier !== "distinct");
      open.push(tableClause && (first === "select" || first === "with" || first === "values"));
      output += character;
      cursor += 1;
      remember(character);
      continue;
    }
    if (character === ")") {
      output += character;
      cursor += 1;
      remember(character);
      if (open.pop()) {
        const next = /^\s*("|[A-Za-z_][A-Za-z0-9_$]*)?/.exec(sql.slice(cursor))?.[1];
        const named = next === '"' || (next !== undefined && !DERIVED_TABLE_FOLLOWERS.has(next.toLowerCase()));
        if (!named) output += ` AS "derived_${(aliases += 1)}"`;
      }
      continue;
    }
    if (!/\s/.test(character)) remember(character);
    output += character;
    cursor += 1;
  }
  return output;
}

function splitTriggerStatements(body: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let cursor = 0;
  let quote: "'" | '"' | "`" | null = null;
  while (cursor < body.length) {
    const character = body[cursor]!;
    if (quote) {
      if (character === quote) {
        if (body[cursor + 1] === quote) cursor += 2;
        else {
          quote = null;
          cursor += 1;
        }
      } else cursor += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      cursor += 1;
      continue;
    }
    if (character === ";") {
      const statement = body.slice(start, cursor).trim();
      if (statement) statements.push(statement);
      start = cursor + 1;
    }
    cursor += 1;
  }
  const final = body.slice(start).trim();
  if (final) statements.push(final);
  return statements;
}

function postgresRaise(messageLiteral: string, condition?: string): string {
  const raise = `RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = ${messageLiteral};`;
  if (!condition?.trim()) return raise;
  return `IF coalesce((${compileSqliteDdlForPostgres(condition)}), false) THEN\n`
    + `    ${raise}\n`
    + "  END IF;";
}

function compileTriggerBody(body: string): string {
  return splitTriggerStatements(body).map((statement) => {
    const raise = /^SELECT\s+RAISE\s*\(\s*ABORT\s*,\s*('(?:''|[^'])*')\s*\)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(
      statement,
    );
    if (raise) return postgresRaise(raise[1]!, raise[2]);
    if (/^SELECT\s+RAISE\b/i.test(statement)) {
      throw new Error("Unsupported SQLite trigger RAISE() shape.");
    }
    return `${compileSqliteDdlForPostgres(statement)};`;
  }).join("\n  ");
}

export function compileSqliteTriggerForPostgres(
  definition: SqliteTriggerDefinition,
): string {
  const match = /^CREATE\s+TRIGGER\s+(.+?)\s+(BEFORE|AFTER)\s+(INSERT|DELETE|UPDATE)(?:\s+OF\s+([\s\S]+?))?\s+ON\s+(.+?)(?:\s+FOR\s+EACH\s+ROW)?(?:\s+WHEN\s+([\s\S]+?))?\s+BEGIN\s+([\s\S]*)\s+END\s*$/i.exec(
    definition.sql.trim(),
  );
  if (!match) {
    throw new Error(`Unsupported SQLite trigger header ${JSON.stringify(definition.name)}.`);
  }
  const [, rawName, timing, event, rawColumns, rawTable, rawWhen, rawBody] = match;
  const triggerName = unquoteIdentifier(rawName!);
  if (triggerName !== definition.name) {
    throw new Error(`SQLite trigger name mismatch for ${JSON.stringify(definition.name)}.`);
  }
  const tableName = unquoteIdentifier(rawTable!);
  const functionName = `${triggerName}_fn`;
  const returnTarget = event!.toUpperCase() === "DELETE" ? "OLD" : "NEW";
  const whenGuard = rawWhen?.trim()
    ? `IF NOT coalesce((${compileSqliteDdlForPostgres(rawWhen)}), false) THEN\n`
      + `    RETURN ${returnTarget};\n`
      + "  END IF;\n  "
    : "";
  const updateColumns = rawColumns?.trim()
    ? ` OF ${rawColumns.split(",").map((column) =>
      quoteIdentifier(unquoteIdentifier(column))).join(", ")}`
    : "";

  return [
    `CREATE OR REPLACE FUNCTION scalius_compat.${quoteIdentifier(functionName)}()`,
    "RETURNS trigger",
    "LANGUAGE plpgsql",
    "AS $trigger_function$",
    "BEGIN",
    `  ${whenGuard}${compileTriggerBody(rawBody!)}`,
    `  RETURN ${returnTarget};`,
    "END",
    "$trigger_function$;",
    `CREATE TRIGGER ${quoteIdentifier(triggerName)}`,
    `${timing!.toUpperCase()} ${event!.toUpperCase()}${updateColumns} ON ${quoteIdentifier(tableName)}`,
    `FOR EACH ROW EXECUTE FUNCTION scalius_compat.${quoteIdentifier(functionName)}();`,
  ].join("\n");
}

/**
 * The search index in PostgreSQL form (search-index.ts): its table and
 * indexes, its triggers by name (one translate() pass per column instead of
 * SQLite's staged replace() chains), and its rebuild from the source rows.
 * It is derived, so it is created after the rows are loaded, and its indexes
 * after its rebuild.
 */
export function searchIndexPostgresSql(): { table: string[]; indexes: string[]; triggers: ReadonlyMap<string, string>; rebuild: string[] } {
  const [table, ...indexes] = SEARCH_INDEX_TABLE_STATEMENTS.map((statement) => `${collatePostgresTextColumns(compileSqliteDdlForPostgres(statement))};`);
  return {
    // A prefix range over 14M terms estimated at 1 row (default statistics):
    // the rank join then ran as a nested loop, 38 s. 10,000 histogram buckets
    // keep the estimate within an order of magnitude.
    table: [table!, `ALTER TABLE ${SEARCH_INDEX_TABLE} ALTER COLUMN term SET STATISTICS 10000;`],
    indexes,
    triggers: new Map(searchIndexTriggers("postgres").map((trigger) => [trigger.name, compileSqliteTriggerForPostgres(trigger)])),
    rebuild: searchIndexRebuildStatements("postgres").map((statement) => `${statement};`),
  };
}

function readSchemaObjects(database: DatabaseSync): readonly SqliteSchemaObject[] {
  return database.prepare(`
    SELECT type, name, tbl_name AS table_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND type IN ('table', 'index')
    ORDER BY type, name
  `).all().map((row) => ({
    type: String(row.type),
    name: String(row.name),
    tableName: String(row.table_name),
    sql: String(row.sql),
  }));
}

function sortTablesByForeignKeys(
  database: DatabaseSync,
  tableObjects: readonly SqliteSchemaObject[],
): readonly SqliteSchemaObject[] {
  const byName = new Map(tableObjects.map((object) => [object.name, object]));
  const pending = new Set(byName.keys());
  const ordered: SqliteSchemaObject[] = [];
  while (pending.size > 0) {
    let advanced = false;
    for (const table of [...pending].sort()) {
      const escaped = table.replaceAll('"', '""');
      const unresolved = database.prepare(`PRAGMA foreign_key_list("${escaped}")`)
        .all()
        .map((row) => String(row.table))
        .filter((dependency) => dependency !== table && pending.has(dependency));
      if (unresolved.length > 0) continue;
      ordered.push(byName.get(table)!);
      pending.delete(table);
      advanced = true;
    }
    if (!advanced) {
      throw new Error(
        `PostgreSQL schema compiler found a foreign-key cycle: ${[...pending].sort().join(", ")}.`,
      );
    }
  }
  return ordered;
}

/**
 * Unique indexes another table's foreign key points at (a composite target
 * that is not the primary key). PostgreSQL needs them before that table's
 * CREATE TABLE, so they move into the pre-data phase beside their table;
 * every other index stays post-data for fast bulk loads.
 */
function foreignKeyTargetIndexes(
  database: DatabaseSync,
  tableObjects: readonly SqliteSchemaObject[],
  indexObjects: readonly SqliteSchemaObject[],
): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const table of tableObjects) {
    const escaped = table.name.replaceAll('"', '""');
    const keys = new Map<number, { table: string; columns: string[] }>();
    for (const row of database.prepare(`PRAGMA foreign_key_list("${escaped}")`).all()) {
      const id = Number(row.id);
      const key = keys.get(id) ?? { table: String(row.table), columns: [] };
      key.columns[Number(row.seq)] = String(row.to);
      keys.set(id, key);
    }
    for (const key of keys.values()) targets.add(`${key.table}(${key.columns.join(",")})`);
  }
  const hoisted = new Set<string>();
  for (const index of indexObjects) {
    if (!/^CREATE\s+UNIQUE\s+INDEX\b/i.test(index.sql) || /\bWHERE\b/i.test(index.sql)) continue;
    const escaped = index.name.replaceAll('"', '""');
    const columns = database.prepare(`PRAGMA index_info("${escaped}")`).all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((row) => String(row.name));
    if (targets.has(`${index.tableName}(${columns.join(",")})`)) hoisted.add(index.name);
  }
  return hoisted;
}

/**
 * The fresh PostgreSQL schema compiled from the canonical SQLite chain.
 * `beforeMigration` stops before that file so sidecar parity tests can
 * upgrade an older schema and compare it with a fresh one.
 */
export async function compileCanonicalPostgresSchema(
  options: { beforeMigration?: string } = {},
): Promise<PostgresSchemaBundle> {
  const database = await createProviderSchemaDatabase("turso", ":memory:", options.beforeMigration);
  try {
    const applicationTables = new Set(readApplicationTableNames(database));
    const objects = readSchemaObjects(database);
    const tableObjects = sortTablesByForeignKeys(
      database,
      objects.filter((object) => object.type === "table" && applicationTables.has(object.name)),
    );
    const allIndexObjects = objects.filter((object) =>
      object.type === "index" && applicationTables.has(object.tableName));
    const foreignKeyTargets = foreignKeyTargetIndexes(database, tableObjects, allIndexObjects);
    const indexObjects = allIndexObjects.filter((object) => !foreignKeyTargets.has(object.name));
    const triggerDefinitions = readFinalTriggerDefinitions(database);
    // Cache dependency triggers have their own PostgreSQL form (deferred
    // constraint triggers that lock the clock at commit), generated from the
    // same registry as the SQLite ones; the SQLite clock triggers have none.
    const cacheDepFunction = triggerDefinitions.some((definition) =>
      typeof cacheDepPostgresTrigger(definition.name, definition.sql) === "string")
      ? [`${CACHE_DEP_POSTGRES_BUMP_FUNCTION};`]
      : [];
    const searchIndex = triggerDefinitions.some((definition) => definition.name.startsWith(`${SEARCH_INDEX_TABLE}_`))
      ? searchIndexPostgresSql()
      : undefined;
    // Event outbox triggers likewise have a generated PostgreSQL form
    // (jsonb facts and a PostgreSQL event id), not the generic compilation.
    const compiledTriggers = triggerDefinitions.flatMap((definition) => {
      // SQLite's index triggers (queued rows) have no PostgreSQL form: its source triggers index directly.
      if (searchIndex && definition.name.startsWith(`${SEARCH_INDEX_TABLE}_`)) {
        const searchTrigger = searchIndex.triggers.get(definition.name);
        return searchTrigger ? [searchTrigger] : [];
      }
      const cacheDep = cacheDepPostgresTrigger(definition.name, definition.sql);
      if (cacheDep === null) return [];
      return [cacheDep ?? eventOutboxPostgresTrigger(definition.name, definition.sql) ?? eventDemandPostgresTrigger(definition.name, definition.sql) ?? compileSqliteTriggerForPostgres(definition)];
    });
    const since0151 = !options.beforeMigration || options.beforeMigration > POSTGRES_SCALE_MIGRATION;
    const preDataSql = [
      "BEGIN;",
      POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL.trim(),
      ...tableObjects.flatMap((object) => [
        `${since0151 ? collatePostgresTextColumns(compileSqliteDdlForPostgres(object.sql)) : compileSqliteDdlForPostgres(object.sql)};`,
        ...allIndexObjects
          .filter((index) => index.tableName === object.name && foreignKeyTargets.has(index.name))
          .map((index) => `${compileSqliteDdlForPostgres(index.sql)};`),
      ]),
      "COMMIT;",
      "",
    ].join("\n\n");
    // From 0151 the change log replaces the clock-row bump (cache-dep-triggers.ts).
    const changeLog = cacheDepFunction.length > 0 && since0151
      ? CACHE_DEP_POSTGRES_LOG_SQL.map((statement) => `${statement};`)
      : [];
    const postDataSql = [
      "BEGIN;",
      ...(!options.beforeMigration || options.beforeMigration > "0154_order_number_sequence.sql" ? POSTGRES_ORDER_NUMBER_SEQUENCE_SQL : []),
      ...indexObjects.map((object) => `${compileSqliteDdlForPostgres(object.sql)};`),
      ...(searchIndex?.table ?? []),
      ...cacheDepFunction,
      ...compiledTriggers,
      ...changeLog,
      ...(searchIndex?.rebuild ?? []),
      ...(searchIndex?.indexes ?? []),
      "COMMIT;",
      "",
    ].join("\n\n");
    const sql = `${preDataSql}${postDataSql}`;
    return {
      version: POSTGRES_SCHEMA_BUNDLE_VERSION,
      preDataSql,
      postDataSql,
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
      applicationTables: tableObjects.length,
      derivedTables: searchIndex ? 1 : 0,
      indexes: allIndexObjects.length,
      triggers: compiledTriggers.length,
    };
  } finally {
    database.close();
  }
}

async function requireMissing(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`PostgreSQL schema output already exists: ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeCreateOnly(path: string, contents: string): Promise<void> {
  await requireMissing(path);
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseOutput(argv: readonly string[]): string {
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--") continue;
    if (argv[index] === "--out") output = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argv[index])}.`);
  }
  if (!output?.trim()) throw new Error("--out is required.");
  return resolve(output);
}

async function main(): Promise<void> {
  const output = parseOutput(process.argv.slice(2));
  const bundle = await compileCanonicalPostgresSchema();
  await writeCreateOnly(output, bundle.sql);
  process.stdout.write(`${JSON.stringify({
    version: bundle.version,
    output,
    sha256: bundle.sha256,
    applicationTables: bundle.applicationTables,
    indexes: bundle.indexes,
    triggers: bundle.triggers,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
