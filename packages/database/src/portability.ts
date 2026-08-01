import {
  connect,
  type Config as TursoConnectionConfig,
  type Connection as TursoConnection,
} from "@tursodatabase/serverless";

export const SQLITE_PORTABILITY_MANIFEST_VERSION =
  "scalius-sqlite-portability/v2" as const;
export const DEFAULT_SQLITE_VERIFICATION_CHUNK_SIZE = 250;

const MAX_SQLITE_VERIFICATION_CHUNK_SIZE = 1_000;
const DEFAULT_IGNORED_TABLES = new Set([
  "_cf_KV",
  "_litestream_lock",
  "d1_migrations",
]);

type QueryParameter = null | string | number | bigint | boolean | Uint8Array;
type QueryRow = Record<string, unknown>;

export interface SqlitePortabilityExecutor {
  query(
    sql: string,
    params?: readonly QueryParameter[],
  ): Promise<readonly QueryRow[]>;
  close?(): Promise<void>;
}

export interface SqlitePortabilityProgress {
  table: string;
  rowsRead: number;
  chunksRead: number;
}

export interface SqlitePortabilityManifestOptions {
  chunkSize?: number;
  ignoredTables?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (
    progress: SqlitePortabilityProgress,
  ) => void | Promise<void>;
}

export interface SqliteTablePortabilityManifest {
  name: string;
  columns: readonly string[];
  primaryKey: readonly string[];
  rowCount: number;
  chunkCount: number;
  contentDigest: string;
}

export interface SqlitePortabilityManifest {
  version: typeof SQLITE_PORTABILITY_MANIFEST_VERSION;
  chunkSize: number;
  schemaDigest: string;
  tables: readonly SqliteTablePortabilityManifest[];
  fingerprint: string;
}

export interface SqlitePortabilityVerification {
  ok: boolean;
  issues: readonly string[];
}

export interface SqlitePortableSchemaObject {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

interface SqliteTableColumn {
  name: string;
  primaryKeyPosition: number;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function requireChunkSize(value: number | undefined): number {
  const chunkSize = value ?? DEFAULT_SQLITE_VERIFICATION_CHUNK_SIZE;
  if (
    !Number.isSafeInteger(chunkSize) ||
    chunkSize < 1 ||
    chunkSize > MAX_SQLITE_VERIFICATION_CHUNK_SIZE
  ) {
    throw new Error(
      `SQLite verification chunkSize must be an integer from 1 to ${MAX_SQLITE_VERIFICATION_CHUNK_SIZE}.`,
    );
  }
  return chunkSize;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Migration verification aborted", "AbortError");
  }
}

function requireString(row: QueryRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`SQLite metadata row is missing ${key}.`);
  }
  return value;
}

function tokenizeSql(value: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < value.length) {
    const character = value[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && value[index + 1] === "-") {
      const end = value.indexOf("\n", index + 2);
      index = end === -1 ? value.length : end + 1;
      continue;
    }
    if (character === "/" && value[index + 1] === "*") {
      const end = value.indexOf("*/", index + 2);
      index = end === -1 ? value.length : end + 2;
      continue;
    }
    if (character === "'") {
      let literal = "'";
      index += 1;
      while (index < value.length) {
        const current = value[index]!;
        literal += current;
        index += 1;
        if (current !== "'") continue;
        if (value[index] === "'") {
          literal += "'";
          index += 1;
          continue;
        }
        break;
      }
      tokens.push(literal);
      continue;
    }
    if (character === '"' || character === "`" || character === "[") {
      const closing = character === "[" ? "]" : character;
      let identifier = "";
      index += 1;
      while (index < value.length) {
        const current = value[index]!;
        index += 1;
        if (current === closing) {
          if (value[index] === closing && closing !== "]") {
            identifier += closing;
            index += 1;
            continue;
          }
          break;
        }
        identifier += current;
      }
      tokens.push(identifier.toLowerCase());
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(value.slice(index))?.[0];
    if (word) {
      const normalized = word.toLowerCase();
      tokens.push(normalized === "true" ? "1" : normalized === "false" ? "0" : normalized);
      index += word.length;
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(value.slice(index))?.[0];
    if (number) {
      tokens.push(number.toLowerCase());
      index += number.length;
      continue;
    }
    const operator = [">=", "<=", "!=", "<>", "==", "||", "->>", "->"]
      .find((candidate) => value.startsWith(candidate, index));
    if (operator) {
      tokens.push(operator === "<>" ? "!=" : operator);
      index += operator.length;
      continue;
    }
    tokens.push(character);
    index += 1;
  }

  return tokens;
}

function stripRedundantOuterParentheses(tokens: readonly string[]): string[] {
  let current = [...tokens];
  while (current[0] === "(" && current.at(-1) === ")") {
    let depth = 0;
    let wrapsEverything = true;
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] === "(") depth += 1;
      else if (current[index] === ")") depth -= 1;
      if (depth === 0 && index < current.length - 1) {
        wrapsEverything = false;
        break;
      }
    }
    if (!wrapsEverything) break;
    current = current.slice(1, -1);
  }
  return current;
}

function canonicalSql(value: string): string {
  const tokens = tokenizeSql(value);
  const normalized: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (
      tokens[index] === "on" &&
      tokens[index + 1] === "update" &&
      tokens[index + 2] === "no" &&
      tokens[index + 3] === "action"
    ) {
      index += 3;
      continue;
    }
    normalized.push(tokens[index]!);
  }
  return stripRedundantOuterParentheses(normalized).join(" ");
}

function readCheckExpressions(createTableSql: string): readonly string[] {
  const tokens = tokenizeSql(createTableSql);
  const checks: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "check" || tokens[index + 1] !== "(") continue;
    let depth = 0;
    const expression: string[] = [];
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor]!;
      if (token === "(") {
        depth += 1;
        if (depth > 1) expression.push(token);
      } else if (token === ")") {
        depth -= 1;
        if (depth === 0) {
          index = cursor;
          break;
        }
        expression.push(token);
      } else {
        expression.push(token);
      }
    }
    checks.push(stripRedundantOuterParentheses(expression).join(" "));
  }
  return checks.sort();
}

function isProviderDerivedSearchObject(name: string): boolean {
  return /_fts(?:_|$)/i.test(name);
}

function isProviderInternalObject(name: string): boolean {
  return /^(?:__turso_|libsql_|_litestream_|_cf_)/i.test(name);
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalValue(value: unknown): readonly [string, string] {
  if (value === null) return ["null", ""];
  if (typeof value === "string") return ["text", value];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "boolean") return ["integer", value ? "1" : "0"];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("SQLite verification cannot encode a non-finite number.");
    }
    return [Number.isInteger(value) ? "integer" : "real", Object.is(value, -0) ? "0" : value.toString()];
  }
  if (value instanceof ArrayBuffer) {
    return ["blob", bytesToHex(new Uint8Array(value))];
  }
  if (ArrayBuffer.isView(value)) {
    return [
      "blob",
      bytesToHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    ];
  }
  throw new Error(
    `SQLite verification encountered unsupported value type ${Object.prototype.toString.call(value)}.`,
  );
}

function canonicalRow(row: QueryRow, columns: readonly string[]): string {
  return JSON.stringify(
    columns.map((column) => [column, canonicalValue(row[column])]),
  );
}

async function readSchemaObjects(
  executor: SqlitePortabilityExecutor,
  ignoredTables: ReadonlySet<string>,
): Promise<readonly SqlitePortableSchemaObject[]> {
  const rows = await executor.query(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `);

  const objects = rows
    .map((row) => ({
      type: requireString(row, "type"),
      name: requireString(row, "name"),
      tableName: requireString(row, "tbl_name"),
      sql: requireString(row, "sql"),
    }))
    .filter(
      (object) =>
        !ignoredTables.has(object.name) &&
        !ignoredTables.has(object.tableName) &&
        !isProviderDerivedSearchObject(object.name) &&
        !isProviderDerivedSearchObject(object.tableName) &&
        !isProviderInternalObject(object.name) &&
        !isProviderInternalObject(object.tableName),
    );

  const explicitIndexSql = new Map(
    objects
      .filter((object) => object.type === "index")
      .map((object) => [object.name, object.sql]),
  );

  return Promise.all(objects.map(async (object) => {
    if (object.type !== "table") {
      return { ...object, sql: canonicalSql(object.sql) };
    }

    const [columnRows, foreignKeyRows, indexRows] = await Promise.all([
      executor.query(`PRAGMA table_info(${quoteIdentifier(object.name)})`),
      executor.query(`PRAGMA foreign_key_list(${quoteIdentifier(object.name)})`),
      executor.query(`PRAGMA index_list(${quoteIdentifier(object.name)})`),
    ]);
    const columns = columnRows
      .map((row) => ({
        cid: Number(row.cid),
        name: requireString(row, "name").toLowerCase(),
        type: String(row.type ?? "").trim().toLowerCase(),
        notNull: Number(row.notnull ?? 0),
        defaultValue: row.dflt_value == null
          ? null
          : canonicalSql(String(row.dflt_value)),
        primaryKeyPosition: Number(row.pk ?? 0),
      }))
      .sort((left, right) => left.cid - right.cid);

    const foreignKeyGroups = new Map<number, Array<Record<string, unknown>>>();
    for (const row of foreignKeyRows) {
      const id = Number(row.id);
      const group = foreignKeyGroups.get(id) ?? [];
      group.push({
        sequence: Number(row.seq),
        table: String(row.table ?? "").toLowerCase(),
        from: String(row.from ?? "").toLowerCase(),
        to: String(row.to ?? "").toLowerCase(),
        onUpdate: String(row.on_update ?? "no action").toLowerCase(),
        onDelete: String(row.on_delete ?? "no action").toLowerCase(),
        match: String(row.match ?? "none").toLowerCase(),
      });
      foreignKeyGroups.set(id, group);
    }
    const foreignKeys = [...foreignKeyGroups.values()]
      .map((group) => group.sort((left, right) =>
        Number(left.sequence) - Number(right.sequence),
      ))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

    const automaticIndexes: Array<Record<string, unknown>> = [];
    for (const indexRow of indexRows) {
      const origin = String(indexRow.origin ?? "").toLowerCase();
      if (origin === "c") continue;
      const indexName = requireString(indexRow, "name");
      if (
        isProviderDerivedSearchObject(indexName) ||
        isProviderInternalObject(indexName)
      ) continue;
      const indexColumns = await executor.query(
        `PRAGMA index_xinfo(${quoteIdentifier(indexName)})`,
      );
      automaticIndexes.push({
        unique: Number(indexRow.unique ?? 0),
        origin,
        partial: Number(indexRow.partial ?? 0),
        columns: indexColumns
          .filter((row) => Number(row.key ?? 1) === 1)
          .map((row) => ({
            sequence: Number(row.seqno),
            cid: Number(row.cid),
            name: row.name == null ? null : String(row.name).toLowerCase(),
            descending: Number(row.desc ?? 0),
            collation: row.coll == null ? null : String(row.coll).toLowerCase(),
          }))
          .sort((left, right) => left.sequence - right.sequence),
      });
    }
    automaticIndexes.sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

    const logicalTable = {
      columns,
      foreignKeys,
      checks: readCheckExpressions(object.sql),
      automaticIndexes,
      // A CREATE INDEX object carries every explicit expression/predicate.
      explicitIndexes: indexRows
        .map((row) => String(row.name ?? ""))
        .filter((name) => explicitIndexSql.has(name))
        .sort(),
    };
    return { ...object, sql: JSON.stringify(logicalTable) };
  }));
}

export async function listSqlitePortableSchemaObjects(
  executor: SqlitePortabilityExecutor,
  ignoredTables: readonly string[] = [],
): Promise<readonly SqlitePortableSchemaObject[]> {
  return readSchemaObjects(
    executor,
    new Set([...DEFAULT_IGNORED_TABLES, ...ignoredTables]),
  );
}

async function readTableColumns(
  executor: SqlitePortabilityExecutor,
  table: string,
): Promise<readonly SqliteTableColumn[]> {
  const rows = await executor.query(
    `PRAGMA table_info(${quoteIdentifier(table)})`,
  );
  const columns = rows
    .map((row) => ({
      name: requireString(row, "name"),
      primaryKeyPosition: Number(row.pk ?? 0),
    }))
    .sort((left, right) => {
      const leftCid = Number(rows.find((row) => row.name === left.name)?.cid ?? 0);
      const rightCid = Number(rows.find((row) => row.name === right.name)?.cid ?? 0);
      return leftCid - rightCid;
    });

  if (columns.length === 0) {
    throw new Error(`SQLite table ${JSON.stringify(table)} has no visible columns.`);
  }
  return columns;
}

function buildPageQuery(
  table: string,
  columns: readonly string[],
  primaryKey: readonly string[],
  hasCursor: boolean,
): string {
  const selectedColumns = columns.map(quoteIdentifier).join(", ");
  const orderColumns = primaryKey.map(quoteIdentifier).join(", ");
  const cursorExpression = primaryKey.length === 1
    ? quoteIdentifier(primaryKey[0]!)
    : `(${orderColumns})`;
  const cursorParameters = primaryKey.length === 1
    ? "?"
    : `(${primaryKey.map(() => "?").join(", ")})`;
  const where = hasCursor
    ? ` WHERE ${cursorExpression} > ${cursorParameters}`
    : "";

  return `SELECT ${selectedColumns} FROM ${quoteIdentifier(table)}${where} ORDER BY ${orderColumns} LIMIT ?`;
}

async function manifestTable(
  executor: SqlitePortabilityExecutor,
  table: string,
  chunkSize: number,
  options: Pick<SqlitePortabilityManifestOptions, "signal" | "onProgress">,
): Promise<SqliteTablePortabilityManifest> {
  const tableColumns = await readTableColumns(executor, table);
  const columns = tableColumns.map((column) => column.name);
  const primaryKey = tableColumns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition)
    .map((column) => column.name);

  if (primaryKey.length === 0) {
    throw new Error(
      `SQLite table ${JSON.stringify(table)} has no primary key; deterministic migration verification refuses rowid ordering.`,
    );
  }
  if (primaryKey.length >= 100) {
    throw new Error(
      `SQLite table ${JSON.stringify(table)} exceeds the portable bind-parameter budget.`,
    );
  }

  let cursor: readonly QueryParameter[] | undefined;
  let rowCount = 0;
  let chunkCount = 0;
  const chunkDigests: string[] = [];

  while (true) {
    throwIfAborted(options.signal);
    const params = cursor ? [...cursor, chunkSize] : [chunkSize];
    const rows = await executor.query(
      buildPageQuery(table, columns, primaryKey, Boolean(cursor)),
      params,
    );
    if (rows.length === 0) break;
    if (rows.length > chunkSize) {
      throw new Error(`SQLite executor exceeded the requested page size for ${table}.`);
    }

    const canonicalRows = rows.map((row) => canonicalRow(row, columns));
    chunkDigests.push(await sha256Hex(canonicalRows.join("\n")));
    rowCount += rows.length;
    chunkCount += 1;

    const lastRow = rows.at(-1)!;
    cursor = primaryKey.map((column) => {
      const value = lastRow[column];
      if (
        value === null ||
        !["string", "number", "bigint", "boolean"].includes(typeof value)
      ) {
        throw new Error(
          `SQLite primary key ${table}.${column} is null or not a portable scalar.`,
        );
      }
      return value as QueryParameter;
    });

    await options.onProgress?.({ table, rowsRead: rowCount, chunksRead: chunkCount });
    if (rows.length < chunkSize) break;
  }

  return {
    name: table,
    columns,
    primaryKey,
    rowCount,
    chunkCount,
    contentDigest: await sha256Hex(
      chunkDigests.map((digest, index) => `${index}:${digest}`).join("\n"),
    ),
  };
}

function manifestFingerprintInput(
  manifest: Omit<SqlitePortabilityManifest, "fingerprint">,
): string {
  return JSON.stringify(manifest);
}

export async function createSqlitePortabilityManifest(
  executor: SqlitePortabilityExecutor,
  options: SqlitePortabilityManifestOptions = {},
): Promise<SqlitePortabilityManifest> {
  const chunkSize = requireChunkSize(options.chunkSize);
  const ignoredTables = new Set([
    ...DEFAULT_IGNORED_TABLES,
    ...(options.ignoredTables ?? []),
  ]);
  throwIfAborted(options.signal);

  const schemaObjects = await readSchemaObjects(executor, ignoredTables);
  const schemaDigest = await sha256Hex(
    schemaObjects
      .map((object) =>
        JSON.stringify([object.type, object.name, object.tableName, object.sql]),
      )
      .join("\n"),
  );
  const tableNames = schemaObjects
    .filter((object) => object.type === "table")
    .map((object) => object.name)
    .sort((left, right) => left.localeCompare(right));
  const tables: SqliteTablePortabilityManifest[] = [];

  for (const table of tableNames) {
    tables.push(await manifestTable(executor, table, chunkSize, options));
  }

  const unsignedManifest = {
    version: SQLITE_PORTABILITY_MANIFEST_VERSION,
    chunkSize,
    schemaDigest,
    tables,
  } as const;
  return {
    ...unsignedManifest,
    fingerprint: await sha256Hex(manifestFingerprintInput(unsignedManifest)),
  };
}

export function verifySqlitePortabilityManifests(
  source: SqlitePortabilityManifest,
  target: SqlitePortabilityManifest,
): SqlitePortabilityVerification {
  const issues: string[] = [];
  if (source.version !== target.version) {
    issues.push(`Manifest version differs: ${source.version} != ${target.version}.`);
  }
  if (source.chunkSize !== target.chunkSize) {
    issues.push(`Verification chunk size differs: ${source.chunkSize} != ${target.chunkSize}.`);
  }
  if (source.schemaDigest !== target.schemaDigest) {
    issues.push("SQLite schema digest differs.");
  }

  const sourceTables = new Map(source.tables.map((table) => [table.name, table]));
  const targetTables = new Map(target.tables.map((table) => [table.name, table]));
  const tableNames = new Set([...sourceTables.keys(), ...targetTables.keys()]);

  for (const tableName of [...tableNames].sort()) {
    const sourceTable = sourceTables.get(tableName);
    const targetTable = targetTables.get(tableName);
    if (!sourceTable) {
      issues.push(`Target contains unexpected table ${tableName}.`);
      continue;
    }
    if (!targetTable) {
      issues.push(`Target is missing table ${tableName}.`);
      continue;
    }
    if (JSON.stringify(sourceTable.columns) !== JSON.stringify(targetTable.columns)) {
      issues.push(`Column order differs for table ${tableName}.`);
    }
    if (JSON.stringify(sourceTable.primaryKey) !== JSON.stringify(targetTable.primaryKey)) {
      issues.push(`Primary key differs for table ${tableName}.`);
    }
    if (sourceTable.rowCount !== targetTable.rowCount) {
      issues.push(
        `Row count differs for table ${tableName}: ${sourceTable.rowCount} != ${targetTable.rowCount}.`,
      );
    }
    if (sourceTable.contentDigest !== targetTable.contentDigest) {
      issues.push(`Content digest differs for table ${tableName}.`);
    }
  }

  return { ok: issues.length === 0, issues };
}

export function createD1PortabilityExecutor(
  binding: D1Database,
): SqlitePortabilityExecutor {
  return {
    async query(sql, params = []) {
      const result = await binding.prepare(sql).bind(...params).all<QueryRow>();
      return result.results ?? [];
    },
  };
}

export function createTursoPortabilityExecutor(
  config: TursoConnectionConfig,
  connectToTurso: (config: TursoConnectionConfig) => TursoConnection = connect,
): SqlitePortabilityExecutor {
  const connection = connectToTurso(config);
  return {
    async query(sql, params = []) {
      const statement = await connection.prepare(sql);
      return await statement.all([...params]) as QueryRow[];
    },
    async close() {
      await connection.close();
    },
  };
}
