import { createHash, type Hash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { chmod, open, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { pathToFileURL } from "node:url";

import pg from "pg";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";

import {
  compileCanonicalPostgresSchema,
  POSTGRES_SCHEMA_BUNDLE_VERSION,
} from "./postgres-schema";
import { readApplicationTableNames } from "./sqlite-provider-schema";
import {
  POSTGRES_MIGRATION_CONTROL_SCHEMA,
  POSTGRES_MIGRATION_LOCK_KEY_SQL,
  POSTGRES_MIGRATION_RECEIPTS_TABLE,
  POSTGRES_MIGRATION_STATE_TABLE,
} from "../src/postgres-migration-control";

export const SQLITE_TO_POSTGRES_CHECKPOINT_VERSION =
  "scalius-sqlite-to-postgres/v4" as const;
export const POSTGRES_CONTENT_FINGERPRINT_VERSION =
  "scalius-postgres-content/v1" as const;
export {
  POSTGRES_MIGRATION_CONTROL_SCHEMA,
  POSTGRES_MIGRATION_LOCK_KEY_SQL,
  POSTGRES_MIGRATION_RECEIPTS_TABLE,
  POSTGRES_MIGRATION_STATE_TABLE,
};
export const POSTGRES_MIGRATION_LOCK_SQL = [
  "SELECT CASE WHEN pg_try_advisory_lock(",
  `  ${POSTGRES_MIGRATION_LOCK_KEY_SQL}`,
  ") THEN 'SCALIUS_LOCKED' ELSE 'SCALIUS_BUSY' END AS lock_result;",
].join("\n");

const { Client: PostgresClient } = pg;

interface MigrationOptions {
  sourcePath: string;
  checkpointPath: string;
  databaseUrl: string;
  acknowledgedTargetHost: string;
}

export interface PostgresMigrationTargetIdentity {
  host: string;
  port: string;
  database: string;
  user: string;
}

export interface TableReceipt {
  name: string;
  rows: number;
  contentSha256: string;
}

export interface MigrationCheckpoint {
  version: typeof SQLITE_TO_POSTGRES_CHECKPOINT_VERSION;
  migrationId: string;
  schemaVersion: typeof POSTGRES_SCHEMA_BUNDLE_VERSION;
  schemaSha256: string;
  sourceSha256: string;
  sourceBytes: number;
  databaseContentSha256: string;
  target: PostgresMigrationTargetIdentity;
  phase: "planned" | "schema" | "data" | "complete";
  tables: TableReceipt[];
}

export interface PostgresTargetMigrationState {
  version: typeof SQLITE_TO_POSTGRES_CHECKPOINT_VERSION;
  migrationId: string;
  schemaVersion: typeof POSTGRES_SCHEMA_BUNDLE_VERSION;
  schemaSha256: string;
  sourceSha256: string;
  sourceBytes: number;
  databaseContentSha256: string;
  target: PostgresMigrationTargetIdentity;
  phase: MigrationCheckpoint["phase"];
  tables: TableReceipt[];
}

export type SqlitePortableColumnType = "text" | "integer" | "real";

export interface SourceColumn {
  name: string;
  type: SqlitePortableColumnType;
}

export interface SourceTable {
  name: string;
  columns: readonly SourceColumn[];
  primaryKey: readonly string[];
  rows: number;
}

export interface TableContentFingerprint {
  name: string;
  rows: number;
  contentSha256: string;
}

export interface DatabaseContentFingerprint {
  version: typeof POSTGRES_CONTENT_FINGERPRINT_VERSION;
  tables: readonly TableContentFingerprint[];
  contentSha256: string;
}

export interface PostgresMigrationTargetReader {
  tableFingerprint(table: SourceTable): Promise<TableContentFingerprint>;
  publicTables(): number | Promise<number>;
  triggers(): number | Promise<number>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("PostgreSQL SQL literal contains an embedded NUL byte.");
  return `'${value.replaceAll("'", "''")}'`;
}

export type CheckpointIdentity = Omit<MigrationCheckpoint, "migrationId" | "phase" | "tables">;
export type ExpectedMigration = Omit<MigrationCheckpoint, "phase" | "tables">;

export function derivePostgresMigrationId(identity: CheckpointIdentity): string {
  const canonical = [
    identity.version,
    identity.schemaVersion,
    identity.schemaSha256,
    identity.sourceSha256,
    String(identity.sourceBytes),
    identity.databaseContentSha256,
    identity.target.host,
    identity.target.port,
    identity.target.database,
    identity.target.user,
  ];
  const hash = createHash("sha256");
  for (const value of canonical) updateFingerprintPart(hash, "M", value);
  return hash.digest("hex");
}

function portableColumnType(value: unknown, table: string, column: string): SqlitePortableColumnType {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.includes("int")) return "integer";
  if (
    normalized.includes("char")
    || normalized.includes("clob")
    || normalized.includes("text")
  ) return "text";
  if (
    normalized.includes("real")
    || normalized.includes("floa")
    || normalized.includes("doub")
  ) return "real";
  if (normalized.includes("blob")) {
    throw new Error(`Source table ${JSON.stringify(table)} contains unsupported BLOB column ${column}.`);
  }
  throw new Error(
    `Source table ${JSON.stringify(table)} column ${column} has unsupported type ${JSON.stringify(normalized)}.`,
  );
}

function parseTargetUrl(databaseUrl: string, acknowledgedTargetHost: string): {
  host: string;
  port: string;
  database: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("POSTGRES_DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol)
    || !host
    || host !== acknowledgedTargetHost.trim().toLowerCase()
  ) {
    throw new Error("PostgreSQL target host does not exactly match its acknowledgement.");
  }
  if (host.includes("-pooler.")) {
    throw new Error("SQLite migration requires a direct, non-pooled PostgreSQL URL.");
  }
  const encodedDatabase = parsed.pathname.slice(1);
  if (!encodedDatabase || encodedDatabase.includes("/")) {
    throw new Error("POSTGRES_DATABASE_URL must name exactly one PostgreSQL database.");
  }
  let database: string;
  try {
    database = decodeURIComponent(encodedDatabase);
  } catch {
    throw new Error("POSTGRES_DATABASE_URL contains an invalid database name.");
  }
  if (!database || /[\r\n\0]/.test(database)) {
    throw new Error("POSTGRES_DATABASE_URL contains an invalid database name.");
  }
  return { host, port: parsed.port || "5432", database };
}

function parseArguments(argv: readonly string[]): MigrationOptions {
  let sourcePath: string | undefined;
  let checkpointPath: string | undefined;
  let acknowledgedTargetHost: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--sqlite") sourcePath = argv[++index];
    else if (argument === "--checkpoint") checkpointPath = argv[++index];
    else if (argument === "--ack-target-host") acknowledgedTargetHost = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!sourcePath?.trim()) throw new Error("--sqlite is required.");
  if (!checkpointPath?.trim()) throw new Error("--checkpoint is required.");
  if (!acknowledgedTargetHost?.trim()) throw new Error("--ack-target-host is required.");

  const databaseUrl = requiredEnvironment("POSTGRES_DATABASE_URL");
  const target = parseTargetUrl(databaseUrl, acknowledgedTargetHost);
  return {
    sourcePath: resolve(sourcePath),
    checkpointPath: resolve(checkpointPath),
    databaseUrl,
    acknowledgedTargetHost: target.host,
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function assertStandaloneSqliteArtifact(path: string): Promise<void> {
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    try {
      await stat(`${path}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      `SQLite migration source has a ${suffix.slice(1)} sidecar; `
      + "checkpoint it into one immutable database file before migration.",
    );
  }
}

export async function assertSourceArtifactUnchanged(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  await assertStandaloneSqliteArtifact(path);
  const current = await stat(path);
  if (!current.isFile() || current.size !== expectedBytes) {
    throw new Error("SQLite migration source changed size or file type during migration.");
  }
  if (await sha256File(path) !== expectedSha256) {
    throw new Error("SQLite migration source content changed during migration.");
  }
}

function readSourceTables(database: DatabaseSync): readonly SourceTable[] {
  const names = readApplicationTableNames(database);
  const byName = new Map<string, SourceTable>();
  for (const name of names) {
    const escaped = name.replaceAll('"', '""');
    const columns = database.prepare(`PRAGMA table_info("${escaped}")`).all()
      .sort((left, right) => Number(left.cid) - Number(right.cid));
    const visible = columns.map((column) => ({
      name: String(column.name),
      type: portableColumnType(column.type, name, String(column.name)),
    }));
    const primaryKey = columns
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => String(column.name));
    if (visible.length === 0 || primaryKey.length === 0) {
      throw new Error(`Source table ${JSON.stringify(name)} lacks columns or a primary key.`);
    }
    const count = Number(database.prepare(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`,
    ).get()?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Source table ${JSON.stringify(name)} returned an invalid row count.`);
    }
    byName.set(name, { name, columns: visible, primaryKey, rows: count });
  }

  const pending = new Set(byName.keys());
  const ordered: SourceTable[] = [];
  while (pending.size > 0) {
    let advanced = false;
    for (const name of [...pending].sort()) {
      const escaped = name.replaceAll('"', '""');
      const unresolved = database.prepare(`PRAGMA foreign_key_list("${escaped}")`).all()
        .map((row) => String(row.table))
        .filter((dependency) => dependency !== name && pending.has(dependency));
      if (unresolved.length > 0) continue;
      ordered.push(byName.get(name)!);
      pending.delete(name);
      advanced = true;
    }
    if (!advanced) {
      throw new Error(`Source schema contains a foreign-key cycle: ${[...pending].join(", ")}.`);
    }
  }
  return ordered;
}

export function assertPostgresMigrationLockResult(result: string): void {
  if (result === "SCALIUS_LOCKED") return;
  if (result === "SCALIUS_BUSY") {
    throw new Error("Another SQLite-to-PostgreSQL migration owns this target database.");
  }
  throw new Error("PostgreSQL migration lock returned an invalid response.");
}

interface PostgresMigrationSession {
  run(sql: string): Promise<void>;
  scalar(sql: string): Promise<string>;
  tableFingerprint(table: SourceTable): Promise<TableContentFingerprint>;
  copy(
    table: SourceTable,
    sourcePath: string,
    receipt: TableReceipt,
    migrationId: string,
  ): Promise<void>;
  close(): Promise<void>;
}

async function openPostgresMigrationSession(
  options: MigrationOptions,
): Promise<PostgresMigrationSession> {
  const client = new PostgresClient({
    connectionString: options.databaseUrl,
    application_name: "scalius-sqlite-to-postgres",
    keepAlive: true,
  });
  let closed = false;

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    await client.end();
  }

  try {
    await client.connect();
    const lock = await client.query<{ lock_result: string }>(POSTGRES_MIGRATION_LOCK_SQL);
    assertPostgresMigrationLockResult(String(lock.rows[0]?.lock_result ?? ""));
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  return {
    async run(sql) {
      await client.query(sql);
    },
    async scalar(sql) {
      const result = await client.query({ text: sql, rowMode: "array" });
      const rows = result.rows as unknown[][];
      if (rows.length !== 1 || rows[0]?.length !== 1 || rows[0][0] === null) {
        throw new Error("PostgreSQL scalar query returned an invalid result shape.");
      }
      return String(rows[0][0]);
    },
    async tableFingerprint(table) {
      const target = client.query(copyTo(buildPostgresFingerprintCopySql(table)));
      const lines = createInterface({ input: target, crlfDelay: Infinity });
      try {
        const fingerprint = await fingerprintPostgresFieldLines(table, lines);
        await finished(target);
        return fingerprint;
      } catch (error) {
        lines.close();
        if (!target.destroyed) target.destroy();
        await finished(target).catch(() => undefined);
        throw error;
      } finally {
        lines.close();
      }
    },
    async copy(table, sourcePath, receipt, migrationId) {
      const source = new DatabaseSync(sourcePath, { readOnly: true });
      let transactionOpen = false;
      try {
        const columnNames = table.columns.map((column) => column.name);
        const columns = columnNames.map(quoteIdentifier).join(", ");
        const order = table.primaryKey.map(quoteIdentifier).join(", ");
        const statement = source.prepare(
          `SELECT ${columns} FROM ${quoteIdentifier(table.name)} ORDER BY ${order};`,
        );
        statement.setReadBigInts(true);

        await client.query("BEGIN");
        transactionOpen = true;
        const target = client.query(copyFrom(buildPostgresTableCopySql(table)));
        await writePostgresCsvRows(
          statement.iterate() as Iterable<Record<string, unknown>>,
          columnNames,
          target,
        );
        if (target.rowCount !== receipt.rows) {
          throw new Error(
            `PostgreSQL COPY row count differs for ${table.name}: `
            + `expected=${receipt.rows}; copied=${target.rowCount}.`,
          );
        }
        await client.query(buildAtomicTableCopySuffix(receipt, migrationId));
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        source.close();
      }
    },
    close,
  };
}

function controlTable(name: string): string {
  return `${quoteIdentifier(POSTGRES_MIGRATION_CONTROL_SCHEMA)}.${quoteIdentifier(name)}`;
}

export function buildPostgresTableCopySql(table: SourceTable): string {
  const columns = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
  return `COPY ${quoteIdentifier(table.name)} (${columns}) FROM STDIN WITH (FORMAT csv);`;
}

export function buildAtomicTableCopySuffix(
  receipt: TableReceipt,
  migrationId: string,
): string {
  return [
    `INSERT INTO ${controlTable(POSTGRES_MIGRATION_RECEIPTS_TABLE)} (`
      + "migration_id, table_name, row_count, content_sha256)",
    `VALUES (${quoteSqlLiteral(migrationId)}, ${quoteSqlLiteral(receipt.name)}, `
      + `${receipt.rows}, ${quoteSqlLiteral(receipt.contentSha256)});`,
    "DO $scalius_migration$",
    "BEGIN",
    `  UPDATE ${controlTable(POSTGRES_MIGRATION_STATE_TABLE)}`,
    "  SET phase = 'data', updated_at = statement_timestamp()",
    `  WHERE migration_id = ${quoteSqlLiteral(migrationId)}`,
    "    AND phase IN ('schema', 'data');",
    "  IF NOT FOUND THEN",
    "    RAISE EXCEPTION 'SQLite-to-PostgreSQL migration phase changed during COPY';",
    "  END IF;",
    "END;",
    "$scalius_migration$;",
    "COMMIT;",
    "",
  ].join("\n");
}

export function encodePostgresCsvField(value: unknown, column: string): string {
  if (value === null) return "";
  if (typeof value === "string") {
    if (value.includes("\0")) {
      throw new Error(`SQLite text column ${column} contains an embedded NUL byte.`);
    }
    return `"${value.replaceAll('"', '""')}"`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`SQLite REAL column ${column} contains a non-finite value.`);
    }
    return Object.is(value, -0) ? "-0" : value.toString();
  }
  if (
    value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
  ) {
    throw new Error(`SQLite column ${column} contains an unsupported BLOB value.`);
  }
  throw new Error(
    `SQLite column ${column} contains unsupported value type ${typeof value}.`,
  );
}

export function encodePostgresCsvRow(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): string {
  return `${columns.map((column) =>
    encodePostgresCsvField(row[column], column)).join(",")}\n`;
}

/**
 * Stream SQLite rows into PostgreSQL COPY without advancing the source iterator
 * while the target writable is applying backpressure. Memory is bounded by one
 * encoded row plus the Writable high-water mark.
 */
export async function writePostgresCsvRows(
  rows: Iterable<Readonly<Record<string, unknown>>>,
  columns: readonly string[],
  output: Writable,
): Promise<void> {
  try {
    await writePostgresCsvRowsOpen(rows, columns, output);
    output.end();
    await finished(output);
  } catch (error) {
    if (!output.destroyed) output.destroy();
    throw error;
  }
}

async function writePostgresCsvRowsOpen(
  rows: Iterable<Readonly<Record<string, unknown>>>,
  columns: readonly string[],
  output: Writable,
): Promise<void> {
  for (const row of rows) {
    if (!output.write(encodePostgresCsvRow(row, columns), "utf8")) {
      await once(output, "drain");
    }
  }
}

const MIN_SQLITE_INTEGER = -9_223_372_036_854_775_808n;
const MAX_SQLITE_INTEGER = 9_223_372_036_854_775_807n;

function updateFingerprintPart(
  hash: Hash,
  tag: string,
  payload: string | Uint8Array = "",
): void {
  const tagBytes = Buffer.from(tag, "utf8");
  if (tagBytes.byteLength !== 1) throw new Error("Fingerprint tags must be one byte.");
  const payloadBytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(payloadBytes.byteLength));
  hash.update(tagBytes);
  hash.update(length);
  hash.update(payloadBytes);
}

function updateTableFingerprintHeader(hash: Hash, table: SourceTable): void {
  updateFingerprintPart(hash, "V", POSTGRES_CONTENT_FINGERPRINT_VERSION);
  updateFingerprintPart(hash, "T", table.name);
  for (const column of table.columns) {
    updateFingerprintPart(hash, "C", column.name);
    updateFingerprintPart(hash, "Y", column.type);
  }
  for (const primaryKey of table.primaryKey) {
    updateFingerprintPart(hash, "P", primaryKey);
  }
}

function canonicalRealBytes(value: number): Buffer {
  const payload = Buffer.allocUnsafe(8);
  payload.writeDoubleBE(value);
  return payload;
}

function updateCanonicalFingerprintValue(
  hash: Hash,
  value: unknown,
  column: SourceColumn,
  table: string,
): void {
  if (value === null) {
    updateFingerprintPart(hash, "N");
    return;
  }
  if (typeof value === "string") {
    if (column.type !== "text") {
      throw new Error(`SQLite column ${table}.${column.name} contains text outside TEXT affinity.`);
    }
    if (value.includes("\0")) {
      throw new Error(`SQLite text column ${table}.${column.name} contains an embedded NUL byte.`);
    }
    updateFingerprintPart(hash, "S", value);
    return;
  }
  if (typeof value === "bigint") {
    if (column.type !== "integer") {
      throw new Error(`SQLite column ${table}.${column.name} contains an integer outside INTEGER affinity.`);
    }
    if (value < MIN_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) {
      throw new Error(`SQLite INTEGER column ${table}.${column.name} exceeds the signed 64-bit range.`);
    }
    updateFingerprintPart(hash, "I", value.toString());
    return;
  }
  if (typeof value === "number") {
    if (column.type !== "real") {
      throw new Error(`SQLite column ${table}.${column.name} contains a REAL outside REAL affinity.`);
    }
    if (!Number.isFinite(value)) {
      throw new Error(`SQLite REAL column ${table}.${column.name} contains a non-finite value.`);
    }
    updateFingerprintPart(hash, "R", canonicalRealBytes(value));
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error(`SQLite column ${table}.${column.name} contains an unsupported BLOB value.`);
  }
  throw new Error(
    `SQLite column ${table}.${column.name} contains unsupported value type ${typeof value}.`,
  );
}

export function fingerprintCanonicalRows(
  table: SourceTable,
  rows: Iterable<Readonly<Record<string, unknown>>>,
): TableContentFingerprint {
  const hash = createHash("sha256");
  updateTableFingerprintHeader(hash, table);
  let rowCount = 0;
  for (const row of rows) {
    updateFingerprintPart(hash, "B");
    for (const column of table.columns) {
      updateCanonicalFingerprintValue(hash, row[column.name], column, table.name);
    }
    updateFingerprintPart(hash, "E");
    rowCount += 1;
  }
  return { name: table.name, rows: rowCount, contentSha256: hash.digest("hex") };
}

export function fingerprintCanonicalDatabase(
  tables: readonly TableContentFingerprint[],
): DatabaseContentFingerprint {
  const byName = new Map<string, TableContentFingerprint>();
  for (const table of tables) {
    if (byName.has(table.name) || !/^[a-f0-9]{64}$/.test(table.contentSha256)) {
      throw new Error("Database content fingerprint contains invalid table evidence.");
    }
    byName.set(table.name, table);
  }
  const ordered = [...byName.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const hash = createHash("sha256");
  updateFingerprintPart(hash, "V", POSTGRES_CONTENT_FINGERPRINT_VERSION);
  for (const table of ordered) {
    updateFingerprintPart(hash, "T", table.name);
    updateFingerprintPart(hash, "D", Buffer.from(table.contentSha256, "hex"));
  }
  return {
    version: POSTGRES_CONTENT_FINGERPRINT_VERSION,
    tables: ordered,
    contentSha256: hash.digest("hex"),
  };
}

function canonicalSqliteOrder(table: SourceTable): string {
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  return table.primaryKey.map((name) => {
    const column = byName.get(name);
    if (!column) throw new Error(`Primary key ${table.name}.${name} is not a visible column.`);
    const identifier = quoteIdentifier(name);
    return column.type === "text" ? `CAST(${identifier} AS BLOB)` : identifier;
  }).join(", ");
}

function fingerprintSqliteTable(
  sourcePath: string,
  table: SourceTable,
): TableContentFingerprint {
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const columns = table.columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const statement = database.prepare(
      `SELECT ${columns} FROM ${quoteIdentifier(table.name)} ORDER BY ${canonicalSqliteOrder(table)}`,
    );
    statement.setReadBigInts(true);
    return fingerprintCanonicalRows(
      table,
      statement.iterate() as Iterable<Record<string, unknown>>,
    );
  } finally {
    database.close();
  }
}

function fingerprintSqliteDatabase(
  sourcePath: string,
  tables: readonly SourceTable[],
): DatabaseContentFingerprint {
  const fingerprints = tables.map((table) => {
    const fingerprint = fingerprintSqliteTable(sourcePath, table);
    if (fingerprint.rows !== table.rows) {
      throw new Error(
        `SQLite content fingerprint row count differs for ${table.name}: ${fingerprint.rows} != ${table.rows}.`,
      );
    }
    return fingerprint;
  });
  return fingerprintCanonicalDatabase(fingerprints);
}

function postgresColumnReference(column: string): string {
  return `scalius_row.${quoteIdentifier(column)}`;
}

function postgresFingerprintField(column: SourceColumn, ordinal: number): string {
  const reference = postgresColumnReference(column.name);
  const kind = column.type === "text" ? "S" : column.type === "integer" ? "I" : "R";
  const payload = column.type === "text"
    ? `replace(encode(convert_to(${reference}, 'UTF8'), 'base64'), E'\\n', '')`
    : column.type === "integer"
      ? `${reference}::text`
      : `encode(float8send(${reference}), 'hex')`;
  return `(${ordinal}, CASE WHEN ${reference} IS NULL THEN 'N' ELSE '${kind}' END, `
    + `CASE WHEN ${reference} IS NULL THEN '' ELSE ${payload} END)`;
}

export function buildPostgresFingerprintCopySql(table: SourceTable): string {
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  const order = table.primaryKey.map((name) => {
    const column = byName.get(name);
    if (!column) throw new Error(`Primary key ${table.name}.${name} is not a visible column.`);
    const reference = postgresColumnReference(name);
    // SQLite ASC ordering places NULL before non-NULL. PostgreSQL defaults to
    // NULLS LAST, so state the ordering explicitly even when canonical PKs are
    // normally non-null.
    return column.type === "text"
      ? `${reference} COLLATE "C" NULLS FIRST`
      : `${reference} NULLS FIRST`;
  });
  return [
    "COPY (",
    "  SELECT scalius_field.ordinal, scalius_field.kind, scalius_field.payload",
    `  FROM ${quoteIdentifier(table.name)} AS scalius_row`,
    "  CROSS JOIN LATERAL (VALUES",
    table.columns.map(postgresFingerprintField).map((field) => `    ${field}`).join(",\n"),
    "  ) AS scalius_field(ordinal, kind, payload)",
    `  ORDER BY ${[...order, "scalius_field.ordinal"].join(", ")}`,
    ") TO STDOUT WITH (FORMAT text, DELIMITER E'\\t');",
  ].join("\n");
}

function parsePostgresFingerprintLine(line: string): {
  ordinal: number;
  kind: string;
  payload: string;
} {
  const first = line.indexOf("\t");
  const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
  if (first < 1 || second < first + 2) {
    throw new Error("PostgreSQL content fingerprint stream contains an invalid field frame.");
  }
  const ordinalText = line.slice(0, first);
  const ordinal = Number(ordinalText);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || String(ordinal) !== ordinalText) {
    throw new Error("PostgreSQL content fingerprint stream contains an invalid ordinal.");
  }
  return {
    ordinal,
    kind: line.slice(first + 1, second),
    payload: line.slice(second + 1),
  };
}

function decodeTargetFingerprintValue(
  hash: Hash,
  frame: { kind: string; payload: string },
  column: SourceColumn,
): void {
  if (frame.kind === "N") {
    if (frame.payload !== "") {
      throw new Error("PostgreSQL null fingerprint field contains a payload.");
    }
    updateFingerprintPart(hash, "N");
    return;
  }
  if (column.type === "text" && frame.kind === "S") {
    const bytes = Buffer.from(frame.payload, "base64");
    const utf8RoundTrip = Buffer.from(bytes.toString("utf8"), "utf8");
    if (
      bytes.toString("base64") !== frame.payload
      || bytes.includes(0)
      || !utf8RoundTrip.equals(bytes)
    ) {
      throw new Error(`PostgreSQL text fingerprint for ${column.name} is not canonical UTF-8 data.`);
    }
    updateFingerprintPart(hash, "S", bytes);
    return;
  }
  if (column.type === "integer" && frame.kind === "I") {
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(frame.payload) || frame.payload === "-0") {
      throw new Error(`PostgreSQL integer fingerprint for ${column.name} is not canonical.`);
    }
    const value = BigInt(frame.payload);
    if (value < MIN_SQLITE_INTEGER || value > MAX_SQLITE_INTEGER) {
      throw new Error(`PostgreSQL integer fingerprint for ${column.name} exceeds SQLite range.`);
    }
    updateFingerprintPart(hash, "I", frame.payload);
    return;
  }
  if (column.type === "real" && frame.kind === "R") {
    if (!/^[a-f0-9]{16}$/.test(frame.payload)) {
      throw new Error(`PostgreSQL REAL fingerprint for ${column.name} is not canonical.`);
    }
    const bytes = Buffer.from(frame.payload, "hex");
    const value = bytes.readDoubleBE();
    if (!Number.isFinite(value)) {
      throw new Error(`PostgreSQL REAL fingerprint for ${column.name} is non-finite.`);
    }
    updateFingerprintPart(hash, "R", bytes);
    return;
  }
  throw new Error(
    `PostgreSQL fingerprint kind ${JSON.stringify(frame.kind)} does not match ${column.name}.`,
  );
}

export async function fingerprintPostgresFieldLines(
  table: SourceTable,
  lines: AsyncIterable<string> | Iterable<string>,
): Promise<TableContentFingerprint> {
  const hash = createHash("sha256");
  updateTableFingerprintHeader(hash, table);
  let expectedOrdinal = 0;
  let rowCount = 0;
  for await (const line of lines) {
    const frame = parsePostgresFingerprintLine(line);
    if (frame.ordinal !== expectedOrdinal) {
      throw new Error(
        `PostgreSQL fingerprint ordinal differs for ${table.name}: ${frame.ordinal} != ${expectedOrdinal}.`,
      );
    }
    if (expectedOrdinal === 0) updateFingerprintPart(hash, "B");
    const column = table.columns[expectedOrdinal];
    if (!column) throw new Error(`PostgreSQL fingerprint exceeded ${table.name} column count.`);
    decodeTargetFingerprintValue(hash, frame, column);
    expectedOrdinal += 1;
    if (expectedOrdinal === table.columns.length) {
      updateFingerprintPart(hash, "E");
      expectedOrdinal = 0;
      rowCount += 1;
    }
  }
  if (expectedOrdinal !== 0) {
    throw new Error(`PostgreSQL fingerprint ended inside a ${table.name} row.`);
  }
  return { name: table.name, rows: rowCount, contentSha256: hash.digest("hex") };
}

export function readCanonicalPostgresTableNames(preDataSql: string): readonly string[] {
  const tables = [...preDataSql.matchAll(/\bCREATE\s+TABLE\s+"((?:""|[^"])*)"/gi)]
    .map((match) => match[1]!.replaceAll('""', '"'));
  if (tables.length === 0 || new Set(tables).size !== tables.length) {
    throw new Error("PostgreSQL schema bundle does not contain a unique canonical table set.");
  }
  return tables;
}

export function buildCanonicalTruncateSql(tableNames: readonly string[]): string {
  const unique = [...new Set(tableNames)];
  if (unique.length === 0 || unique.length !== tableNames.length) {
    throw new Error("PostgreSQL canonical truncate requires a non-empty unique table set.");
  }
  return [
    "BEGIN;",
    `TRUNCATE TABLE ${[...unique].sort().map(quoteIdentifier).join(", ")};`,
    "COMMIT;",
    "",
  ].join("\n");
}

function unwrapCanonicalTransaction(sql: string, label: string): string {
  const trimmed = sql.trim();
  if (!trimmed.startsWith("BEGIN;") || !trimmed.endsWith("COMMIT;")) {
    throw new Error(`${label} must have one canonical outer transaction.`);
  }
  return trimmed.slice("BEGIN;".length, -"COMMIT;".length).trim();
}

function buildPhaseUpdateBlock(
  migrationId: string,
  fromPhases: readonly MigrationCheckpoint["phase"][],
  toPhase: MigrationCheckpoint["phase"],
  extraCondition?: string,
): string {
  const phases = fromPhases.map(quoteSqlLiteral).join(", ");
  return [
    "DO $scalius_migration$",
    "BEGIN",
    `  UPDATE ${controlTable(POSTGRES_MIGRATION_STATE_TABLE)}`,
    `  SET phase = ${quoteSqlLiteral(toPhase)}, updated_at = statement_timestamp()`,
    `  WHERE migration_id = ${quoteSqlLiteral(migrationId)}`,
    `    AND phase IN (${phases})${extraCondition ? `\n    AND ${extraCondition}` : ""};`,
    "  IF NOT FOUND THEN",
    `    RAISE EXCEPTION 'Cannot advance SQLite-to-PostgreSQL migration to ${toPhase}';`,
    "  END IF;",
    "END;",
    "$scalius_migration$;",
  ].join("\n");
}

export function buildInitialPostgresTargetSql(
  preDataSql: string,
  tableNames: readonly string[],
  migrationId: string,
): string {
  const unique = [...new Set(tableNames)];
  if (unique.length === 0 || unique.length !== tableNames.length) {
    throw new Error("PostgreSQL initial target transaction requires a unique table set.");
  }
  return [
    "BEGIN;",
    unwrapCanonicalTransaction(preDataSql, "PostgreSQL pre-data SQL"),
    `TRUNCATE TABLE ${[...unique].sort().map(quoteIdentifier).join(", ")};`,
    buildPhaseUpdateBlock(migrationId, ["planned"], "schema"),
    "COMMIT;",
    "",
  ].join("\n");
}

export function buildPostgresMigrationControlSql(expected: ExpectedMigration): string {
  return [
    "BEGIN;",
    `CREATE SCHEMA ${quoteIdentifier(POSTGRES_MIGRATION_CONTROL_SCHEMA)};`,
    `REVOKE ALL ON SCHEMA ${quoteIdentifier(POSTGRES_MIGRATION_CONTROL_SCHEMA)} FROM PUBLIC;`,
    `CREATE TABLE ${controlTable(POSTGRES_MIGRATION_STATE_TABLE)} (`,
    "  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),",
    "  migration_id text NOT NULL UNIQUE,",
    "  version text NOT NULL,",
    "  schema_version text NOT NULL,",
    "  schema_sha256 text NOT NULL CHECK (schema_sha256 ~ '^[a-f0-9]{64}$'),",
    "  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),",
    "  source_bytes bigint NOT NULL CHECK (source_bytes > 0),",
    "  database_content_sha256 text NOT NULL CHECK (database_content_sha256 ~ '^[a-f0-9]{64}$'),",
    "  target_host text NOT NULL,",
    "  target_port text NOT NULL,",
    "  target_database text NOT NULL,",
    "  target_user text NOT NULL,",
    "  phase text NOT NULL CHECK (phase IN ('planned', 'schema', 'data', 'complete')),",
    "  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()",
    ");",
    `CREATE TABLE ${controlTable(POSTGRES_MIGRATION_RECEIPTS_TABLE)} (`,
    "  migration_id text NOT NULL REFERENCES "
      + `${controlTable(POSTGRES_MIGRATION_STATE_TABLE)} (migration_id) ON DELETE RESTRICT,`,
    "  table_name text NOT NULL,",
    "  row_count bigint NOT NULL CHECK (row_count >= 0),",
    "  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),",
    "  committed_at timestamptz NOT NULL DEFAULT statement_timestamp(),",
    "  PRIMARY KEY (migration_id, table_name)",
    ");",
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${quoteIdentifier(POSTGRES_MIGRATION_CONTROL_SCHEMA)} `
      + "FROM PUBLIC;",
    `INSERT INTO ${controlTable(POSTGRES_MIGRATION_STATE_TABLE)} (`,
    "  migration_id, version, schema_version, schema_sha256, source_sha256, source_bytes,",
    "  database_content_sha256, target_host, target_port, target_database, target_user, phase",
    ") VALUES (",
    `  ${quoteSqlLiteral(expected.migrationId)}, ${quoteSqlLiteral(expected.version)},`,
    `  ${quoteSqlLiteral(expected.schemaVersion)}, ${quoteSqlLiteral(expected.schemaSha256)},`,
    `  ${quoteSqlLiteral(expected.sourceSha256)}, ${expected.sourceBytes},`,
    `  ${quoteSqlLiteral(expected.databaseContentSha256)}, ${quoteSqlLiteral(expected.target.host)},`,
    `  ${quoteSqlLiteral(expected.target.port)}, ${quoteSqlLiteral(expected.target.database)},`,
    `  ${quoteSqlLiteral(expected.target.user)}, 'planned'`,
    ");",
    "COMMIT;",
    "",
  ].join("\n");
}

export function buildPostDataCompletionSql(
  postDataSql: string,
  migrationId: string,
  expectedTableCount: number,
): string {
  if (!Number.isSafeInteger(expectedTableCount) || expectedTableCount < 1) {
    throw new Error("PostgreSQL completion requires a positive table receipt count.");
  }
  const receiptCount = `(SELECT count(*) FROM ${controlTable(POSTGRES_MIGRATION_RECEIPTS_TABLE)} `
    + `WHERE migration_id = ${quoteSqlLiteral(migrationId)}) = ${expectedTableCount}`;
  return [
    "BEGIN;",
    unwrapCanonicalTransaction(postDataSql, "PostgreSQL post-data SQL"),
    buildPhaseUpdateBlock(migrationId, ["schema", "data"], "complete", receiptCount),
    "COMMIT;",
    "",
  ].join("\n");
}

async function writeCheckpoint(
  path: string,
  checkpoint: MigrationCheckpoint,
): Promise<void> {
  const contents = `${JSON.stringify(checkpoint, null, 2)}\n`;
  const temporary = `${path}.next`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function validateCheckpoint(
  checkpoint: MigrationCheckpoint,
  expected: ExpectedMigration,
): void {
  const target = checkpoint.target;
  if (
    checkpoint.version !== expected.version
    || checkpoint.migrationId !== expected.migrationId
    || checkpoint.schemaVersion !== expected.schemaVersion
    || checkpoint.schemaSha256 !== expected.schemaSha256
    || checkpoint.sourceSha256 !== expected.sourceSha256
    || checkpoint.sourceBytes !== expected.sourceBytes
    || checkpoint.databaseContentSha256 !== expected.databaseContentSha256
    || !target
    || target.host !== expected.target.host
    || target.port !== expected.target.port
    || target.database !== expected.target.database
    || target.user !== expected.target.user
  ) {
    throw new Error("SQLite-to-PostgreSQL checkpoint does not match this source/schema/target.");
  }
}

export function checkpointFromPostgresTargetState(
  state: PostgresTargetMigrationState,
  expected: ExpectedMigration,
): MigrationCheckpoint {
  const checkpoint: MigrationCheckpoint = {
    version: state.version,
    migrationId: state.migrationId,
    schemaVersion: state.schemaVersion,
    schemaSha256: state.schemaSha256,
    sourceSha256: state.sourceSha256,
    sourceBytes: state.sourceBytes,
    databaseContentSha256: state.databaseContentSha256,
    target: state.target,
    phase: state.phase,
    tables: state.tables,
  };
  validateCheckpoint(checkpoint, expected);
  if (!["planned", "schema", "data", "complete"].includes(checkpoint.phase)) {
    throw new Error("PostgreSQL target migration phase is invalid.");
  }
  return checkpoint;
}

function parseTargetStateJson(raw: string): PostgresTargetMigrationState {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("PostgreSQL migration control state returned invalid JSON.");
  }
  const target = parsed.target as Record<string, unknown> | undefined;
  const tableValues = parsed.tables;
  if (!target || !Array.isArray(tableValues)) {
    throw new Error("PostgreSQL migration control state has an invalid shape.");
  }
  const sourceBytes = Number(parsed.sourceBytes);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 1) {
    throw new Error("PostgreSQL migration control state has invalid source bytes.");
  }
  const tables = tableValues.map((value) => {
    const receipt = value as Record<string, unknown>;
    const rows = Number(receipt.rows);
    if (
      typeof receipt.name !== "string"
      || !Number.isSafeInteger(rows)
      || rows < 0
      || typeof receipt.contentSha256 !== "string"
    ) {
      throw new Error("PostgreSQL migration control receipt has an invalid shape.");
    }
    return { name: receipt.name, rows, contentSha256: receipt.contentSha256 };
  });
  return {
    version: String(parsed.version) as PostgresTargetMigrationState["version"],
    migrationId: String(parsed.migrationId),
    schemaVersion: String(parsed.schemaVersion) as PostgresTargetMigrationState["schemaVersion"],
    schemaSha256: String(parsed.schemaSha256),
    sourceSha256: String(parsed.sourceSha256),
    sourceBytes,
    databaseContentSha256: String(parsed.databaseContentSha256),
    target: {
      host: String(target.host),
      port: String(target.port),
      database: String(target.database),
      user: String(target.user),
    },
    phase: String(parsed.phase) as PostgresTargetMigrationState["phase"],
    tables,
  };
}

async function readPostgresTargetMigrationState(
  session: PostgresMigrationSession,
): Promise<PostgresTargetMigrationState | null> {
  const exists = await session.scalar(
    `SELECT CASE WHEN to_regclass(${quoteSqlLiteral(
      `${POSTGRES_MIGRATION_CONTROL_SCHEMA}.${POSTGRES_MIGRATION_STATE_TABLE}`,
    )}) IS NULL THEN 'missing' ELSE 'present' END`,
  );
  if (exists === "missing") return null;
  if (exists !== "present") {
    throw new Error("PostgreSQL migration control schema probe returned an invalid result.");
  }
  const raw = await session.scalar(`
    SELECT json_build_object(
      'version', state.version,
      'migrationId', state.migration_id,
      'schemaVersion', state.schema_version,
      'schemaSha256', state.schema_sha256,
      'sourceSha256', state.source_sha256,
      'sourceBytes', state.source_bytes::text,
      'databaseContentSha256', state.database_content_sha256,
      'target', json_build_object(
        'host', state.target_host,
        'port', state.target_port,
        'database', state.target_database,
        'user', state.target_user
      ),
      'phase', state.phase,
      'tables', COALESCE((
        SELECT json_agg(json_build_object(
          'name', receipt.table_name,
          'rows', receipt.row_count::text,
          'contentSha256', receipt.content_sha256
        ) ORDER BY receipt.table_name)
        FROM ${controlTable(POSTGRES_MIGRATION_RECEIPTS_TABLE)} AS receipt
        WHERE receipt.migration_id = state.migration_id
      ), '[]'::json)
    )::text
    FROM ${controlTable(POSTGRES_MIGRATION_STATE_TABLE)} AS state
  `);
  if (!raw) throw new Error("PostgreSQL migration control state is missing its singleton row.");
  return parseTargetStateJson(raw);
}

function requireTargetCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} returned an invalid count.`);
  }
  return value;
}

export function validateCheckpointTargetReceipts(
  checkpoint: MigrationCheckpoint,
  sourceTables: readonly SourceTable[],
  sourceContent: DatabaseContentFingerprint,
): void {
  if (!Array.isArray(checkpoint.tables)) {
    throw new Error("PostgreSQL checkpoint table receipts are invalid.");
  }
  const sourceByName = new Map(sourceTables.map((table) => [table.name, table]));
  const sourceFingerprints = new Map(sourceContent.tables.map((table) => [table.name, table]));
  const seen = new Set<string>();
  for (const receipt of checkpoint.tables) {
    if (seen.has(receipt.name)) {
      throw new Error(`Checkpoint contains duplicate receipt for ${receipt.name}.`);
    }
    seen.add(receipt.name);
    const source = sourceByName.get(receipt.name);
    const sourceFingerprint = sourceFingerprints.get(receipt.name);
    if (
      !source
      || !sourceFingerprint
      || receipt.rows !== source.rows
      || receipt.contentSha256 !== sourceFingerprint.contentSha256
    ) {
      throw new Error(`Checkpoint content receipt differs for ${receipt.name}.`);
    }
  }
  for (let index = 0; index < sourceTables.length; index += 1) {
    const mustBeCommitted = index < seen.size;
    if (seen.has(sourceTables[index]!.name) !== mustBeCommitted) {
      throw new Error("PostgreSQL target receipts are not a canonical table prefix.");
    }
  }
  if (
    ((checkpoint.phase === "planned" || checkpoint.phase === "schema") && seen.size !== 0)
    || (checkpoint.phase === "data" && seen.size === 0)
  ) {
    throw new Error(`PostgreSQL target receipts are invalid for ${checkpoint.phase} phase.`);
  }
  if (checkpoint.phase === "complete" && seen.size !== sourceTables.length) {
    throw new Error("Completed PostgreSQL checkpoint is missing table receipts.");
  }
}

export async function revalidateMigrationCheckpointTarget(
  checkpoint: MigrationCheckpoint,
  sourceTables: readonly SourceTable[],
  sourceContent: DatabaseContentFingerprint,
  schema: { applicationTables: number; triggers: number },
  target: PostgresMigrationTargetReader,
): Promise<void> {
  validateCheckpointTargetReceipts(checkpoint, sourceTables, sourceContent);
  const sourceByName = new Map(sourceTables.map((table) => [table.name, table]));
  const targetFingerprints: TableContentFingerprint[] = [];
  for (const receipt of checkpoint.tables) {
    const source = sourceByName.get(receipt.name)!;
    const targetFingerprint = await target.tableFingerprint(source);
    targetFingerprints.push(targetFingerprint);
    if (
      targetFingerprint.name !== receipt.name
      || targetFingerprint.rows !== receipt.rows
      || targetFingerprint.contentSha256 !== receipt.contentSha256
    ) {
      throw new Error(
        `PostgreSQL content fingerprint differs for ${receipt.name}.`,
      );
    }
  }

  if (checkpoint.tables.length === sourceTables.length) {
    const targetContent = fingerprintCanonicalDatabase(targetFingerprints);
    if (
      checkpoint.databaseContentSha256 !== sourceContent.contentSha256
      || targetContent.contentSha256 !== sourceContent.contentSha256
    ) {
      throw new Error("PostgreSQL whole-database content fingerprint differs from SQLite.");
    }
  }
  const publicTables = requireTargetCount(
    await target.publicTables(),
    "PostgreSQL public schema",
  );
  const triggers = requireTargetCount(
    await target.triggers(),
    "PostgreSQL trigger catalog",
  );
  const expectedPublicTables = checkpoint.phase === "planned" ? 0 : schema.applicationTables;
  const expectedTriggers = checkpoint.phase === "complete" ? schema.triggers : 0;
  if (publicTables !== expectedPublicTables || triggers !== expectedTriggers) {
    throw new Error(`PostgreSQL target schema counts differ in ${checkpoint.phase} phase.`);
  }
}

async function readConnectedTargetIdentity(
  session: PostgresMigrationSession,
  options: MigrationOptions,
): Promise<PostgresMigrationTargetIdentity> {
  const parsed = parseTargetUrl(options.databaseUrl, options.acknowledgedTargetHost);
  const raw = await session.scalar(`
    SELECT json_build_object(
      'database', current_database(),
      'user', current_user
    )::text
  `);
  let connected: { database?: unknown; user?: unknown };
  try {
    connected = JSON.parse(raw) as { database?: unknown; user?: unknown };
  } catch {
    throw new Error("PostgreSQL target identity probe returned invalid JSON.");
  }
  if (
    connected.database !== parsed.database
    || typeof connected.user !== "string"
    || !connected.user
  ) {
    throw new Error("PostgreSQL connection resolved to an unexpected target identity.");
  }
  return { ...parsed, user: connected.user };
}

export async function migrateSqliteToPostgres(
  options: MigrationOptions,
): Promise<MigrationCheckpoint> {
  await assertStandaloneSqliteArtifact(options.sourcePath);
  const sourceStats = await stat(options.sourcePath);
  if (!sourceStats.isFile() || sourceStats.size < 1) {
    throw new Error("SQLite migration source must be a non-empty file.");
  }
  const source = new DatabaseSync(options.sourcePath, { readOnly: true });
  let sourceTables: readonly SourceTable[];
  try {
    const integrity = String(
      Object.values(source.prepare("PRAGMA integrity_check").get() ?? {})[0] ?? "",
    ).toLowerCase();
    const foreignKeyViolations = source.prepare("PRAGMA foreign_key_check").all().length;
    if (integrity !== "ok" || foreignKeyViolations !== 0) {
      throw new Error("SQLite migration source failed integrity or foreign-key checks.");
    }
    sourceTables = readSourceTables(source);
  } finally {
    source.close();
  }
  if (sourceTables.length < 100) {
    throw new Error("SQLite migration source is missing canonical application tables.");
  }

  const schema = await compileCanonicalPostgresSchema();
  const canonicalTableNames = readCanonicalPostgresTableNames(schema.preDataSql);
  if (canonicalTableNames.length !== schema.applicationTables) {
    throw new Error("PostgreSQL schema bundle table count is inconsistent.");
  }
  const sourceTableNames = new Set(sourceTables.map((table) => table.name));
  if (
    sourceTableNames.size !== canonicalTableNames.length
    || canonicalTableNames.some((table) => !sourceTableNames.has(table))
  ) {
    throw new Error("SQLite migration source table set differs from the canonical schema.");
  }
  const session = await openPostgresMigrationSession(options);
  async function executeMigration(): Promise<MigrationCheckpoint> {
    const targetIdentity = await readConnectedTargetIdentity(session, options);
    const sourceContent = fingerprintSqliteDatabase(options.sourcePath, sourceTables);
    const identity: CheckpointIdentity = {
      version: SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
      schemaVersion: schema.version,
      schemaSha256: schema.sha256,
      sourceSha256: await sha256File(options.sourcePath),
      sourceBytes: sourceStats.size,
      databaseContentSha256: sourceContent.contentSha256,
      target: targetIdentity,
    };
    const expected: ExpectedMigration = {
      ...identity,
      migrationId: derivePostgresMigrationId(identity),
    };
    const targetReader: PostgresMigrationTargetReader = {
      tableFingerprint(table) {
        return session.tableFingerprint(table);
      },
      async publicTables() {
        return Number(await session.scalar(
          "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
        ));
      },
      async triggers() {
        return Number(await session.scalar(
          "SELECT count(*) FROM information_schema.triggers WHERE trigger_schema = 'public'",
        ));
      },
    };
    const sourceFingerprints = new Map(
      sourceContent.tables.map((table) => [table.name, table]),
    );
    let targetState = await readPostgresTargetMigrationState(session);
    if (!targetState) {
      const publicTables = await targetReader.publicTables();
      const triggers = await targetReader.triggers();
      if (publicTables !== 0 || triggers !== 0) {
        throw new Error("Fresh PostgreSQL migration target must not contain public tables or triggers.");
      }
      await session.run(buildPostgresMigrationControlSql(expected));
      targetState = await readPostgresTargetMigrationState(session);
      if (!targetState) {
        throw new Error("PostgreSQL migration control transaction did not commit its identity.");
      }
    }

    let checkpoint = checkpointFromPostgresTargetState(targetState, expected);
    await revalidateMigrationCheckpointTarget(
      checkpoint,
      sourceTables,
      sourceContent,
      schema,
      targetReader,
    );
    await writeCheckpoint(options.checkpointPath, checkpoint);
    if (checkpoint.phase === "complete") {
      await assertSourceArtifactUnchanged(
        options.sourcePath,
        identity.sourceBytes,
        identity.sourceSha256,
      );
      return checkpoint;
    }

    if (checkpoint.phase === "planned") {
      await session.run(buildInitialPostgresTargetSql(
        schema.preDataSql,
        canonicalTableNames,
        expected.migrationId,
      ));
      targetState = await readPostgresTargetMigrationState(session);
      if (!targetState) throw new Error("PostgreSQL migration control state disappeared.");
      checkpoint = checkpointFromPostgresTargetState(targetState, expected);
      await revalidateMigrationCheckpointTarget(
        checkpoint,
        sourceTables,
        sourceContent,
        schema,
        targetReader,
      );
      await writeCheckpoint(options.checkpointPath, checkpoint);
    }

    let completed = new Map(checkpoint.tables.map((table) => [table.name, table]));
    for (const table of sourceTables) {
      if (completed.has(table.name)) continue;
      const sourceFingerprint = sourceFingerprints.get(table.name);
      if (!sourceFingerprint) {
        throw new Error(`SQLite content fingerprint is missing ${table.name}.`);
      }
      await session.copy(
        table,
        options.sourcePath,
        sourceFingerprint,
        expected.migrationId,
      );
      targetState = await readPostgresTargetMigrationState(session);
      if (!targetState) throw new Error("PostgreSQL migration control state disappeared.");
      checkpoint = checkpointFromPostgresTargetState(targetState, expected);
      validateCheckpointTargetReceipts(checkpoint, sourceTables, sourceContent);
      completed = new Map(checkpoint.tables.map((receipt) => [receipt.name, receipt]));
      const committedReceipt = completed.get(table.name);
      if (
        !committedReceipt
        || committedReceipt.rows !== sourceFingerprint.rows
        || committedReceipt.contentSha256 !== sourceFingerprint.contentSha256
      ) {
        throw new Error(`PostgreSQL target receipt differs for ${table.name} after COPY.`);
      }
      const targetFingerprint = await targetReader.tableFingerprint(table);
      if (
        targetFingerprint.name !== sourceFingerprint.name
        || targetFingerprint.rows !== sourceFingerprint.rows
        || targetFingerprint.contentSha256 !== sourceFingerprint.contentSha256
      ) {
        throw new Error(
          `PostgreSQL content fingerprint differs for ${table.name} after COPY.`,
        );
      }
      await writeCheckpoint(options.checkpointPath, checkpoint);
    }

    await revalidateMigrationCheckpointTarget(
      checkpoint,
      sourceTables,
      sourceContent,
      schema,
      targetReader,
    );
    await session.run(buildPostDataCompletionSql(
      schema.postDataSql,
      expected.migrationId,
      sourceTables.length,
    ));
    targetState = await readPostgresTargetMigrationState(session);
    if (!targetState) throw new Error("PostgreSQL migration control state disappeared.");
    checkpoint = checkpointFromPostgresTargetState(targetState, expected);
    await revalidateMigrationCheckpointTarget(
      checkpoint,
      sourceTables,
      sourceContent,
      schema,
      targetReader,
    );
    await assertSourceArtifactUnchanged(
      options.sourcePath,
      identity.sourceBytes,
      identity.sourceSha256,
    );
    await writeCheckpoint(options.checkpointPath, checkpoint);
    return checkpoint;
  }

  let migrationResult: MigrationCheckpoint | undefined;
  let migrationError: unknown;
  try {
    migrationResult = await executeMigration();
  } catch (error) {
    migrationError = error;
  }
  let closeError: unknown;
  try {
    await session.close();
  } catch (error) {
    closeError = error;
  }
  if (migrationError) throw migrationError;
  if (closeError) throw closeError;
  if (!migrationResult) throw new Error("PostgreSQL migration ended without a target result.");
  return migrationResult;
}

async function main(): Promise<void> {
  const checkpoint = await migrateSqliteToPostgres(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    version: checkpoint.version,
    migrationId: checkpoint.migrationId,
    phase: checkpoint.phase,
    schemaSha256: checkpoint.schemaSha256,
    sourceSha256: checkpoint.sourceSha256,
    sourceBytes: checkpoint.sourceBytes,
    databaseContentSha256: checkpoint.databaseContentSha256,
    target: checkpoint.target,
    tables: checkpoint.tables.length,
    rows: checkpoint.tables.reduce((sum, table) => sum + table.rows, 0),
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
