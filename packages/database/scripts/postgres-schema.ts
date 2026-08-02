import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import {
  compileSqliteNullSafeComparisons,
  POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL,
} from "../src/postgres-sqlite-profile";
import { CHECKOUT_COMMIT_HARD_MAX_ORDERS } from "../src/checkout-commit";
import { buildPostgresCheckoutCommitFunctionSql } from "../src/postgres-checkout";
import type { SqliteTriggerDefinition } from "../src/migration-artifacts";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
  readFinalTriggerDefinitions,
} from "./sqlite-provider-schema";

export const POSTGRES_SCHEMA_BUNDLE_VERSION =
  "scalius-postgres-schema/v1" as const;

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

function compileGlobPatterns(sql: string): string {
  return sql
    .replaceAll("'*[^A-Z]*'", "'[^A-Z]'")
    .replaceAll("'*[^A-Z0-9_-]*'", "'[^A-Z0-9_-]'")
    .replaceAll("'*[^A-Za-z0-9_-]*'", "'[^A-Za-z0-9_-]'")
    .replace(/\bNOT\s+GLOB\b/gi, "!~")
    .replace(/\bGLOB\b/gi, "~");
}

function compileNumericJsonChecks(sql: string): string {
  return sql.replace(
    /json_extract\(([^,]+),\s*('\$\.(?:amountMinor|basisPoints|quantity)')\)\s+BETWEEN/gi,
    "CAST(json_extract($1, $2) AS bigint) BETWEEN",
  );
}

/** Compile trusted canonical SQLite DDL/body SQL into the Postgres profile. */
export function compileSqliteDdlForPostgres(sql: string): string {
  let source = compileSqliteNullSafeComparisons(
    compileNumericJsonChecks(compileGlobPatterns(sql)),
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
  return output.replace(/\),\s*0\)\s*\)/g, "), false))");
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
  const sourceSql = definition.name === "checkout_batch_outbox_shape_guard"
    ? definition.sql.replace(
      /json_array_length\(NEW\.`order_ids`\)\s+NOT\s+BETWEEN\s+1\s+AND\s+280/i,
      `json_array_length(NEW.\`order_ids\`) NOT BETWEEN 1 AND ${CHECKOUT_COMMIT_HARD_MAX_ORDERS}`,
    )
    : definition.sql;
  const match = /^CREATE\s+TRIGGER\s+(.+?)\s+(BEFORE|AFTER)\s+(INSERT|DELETE|UPDATE)(?:\s+OF\s+([\s\S]+?))?\s+ON\s+(.+?)(?:\s+FOR\s+EACH\s+ROW)?(?:\s+WHEN\s+([\s\S]+?))?\s+BEGIN\s+([\s\S]*)\s+END\s*$/i.exec(
    sourceSql.trim(),
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

export async function compileCanonicalPostgresSchema(): Promise<PostgresSchemaBundle> {
  const database = await createProviderSchemaDatabase("turso");
  try {
    const applicationTables = new Set(readApplicationTableNames(database));
    const objects = readSchemaObjects(database);
    const tableObjects = sortTablesByForeignKeys(
      database,
      objects.filter((object) => object.type === "table" && applicationTables.has(object.name)),
    );
    const indexObjects = objects.filter((object) =>
      object.type === "index" && applicationTables.has(object.tableName));
    const triggerDefinitions = readFinalTriggerDefinitions(database);
    const preDataSql = [
      "BEGIN;",
      POSTGRES_SQLITE_PROFILE_BOOTSTRAP_SQL.trim(),
      ...tableObjects.map((object) => `${compileSqliteDdlForPostgres(object.sql)};`),
      "COMMIT;",
      "",
    ].join("\n\n");
    const postDataSql = [
      "BEGIN;",
      ...indexObjects.map((object) => `${compileSqliteDdlForPostgres(object.sql)};`),
      ...triggerDefinitions.map(compileSqliteTriggerForPostgres),
      buildPostgresCheckoutCommitFunctionSql(),
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
      indexes: indexObjects.length,
      triggers: triggerDefinitions.length,
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
