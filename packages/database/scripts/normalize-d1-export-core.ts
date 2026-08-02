import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createSqlitePortabilityManifest,
  type SqlitePortabilityExecutor,
  type SqlitePortabilityManifest,
} from "../src/portability";
import {
  canonicalMigrationDirectory,
  createProviderSchemaDatabase,
  dropTriggers,
  loadSqliteSqlFile,
  readFinalTriggerDefinitions,
  restoreTriggers,
} from "./sqlite-provider-schema";
import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import type { DatabaseProvider } from "../src/provider";

interface TableColumn {
  name: string;
  notNull: boolean;
}

interface TablePlan {
  table: string;
  targetColumns: readonly TableColumn[];
  sourceColumns: readonly TableColumn[];
}

export interface IgnoredSourceTable {
  table: string;
  rowCount: number;
}

export const RETIRED_SCHEMA_ARCHIVE_VERSION =
  "scalius-retired-schema-archive/v1" as const;

export interface ArchivedRetiredTable extends IgnoredSourceTable {
  contentSha256: string;
}

export interface RetiredSchemaArchiveReceipt {
  version: typeof RETIRED_SCHEMA_ARCHIVE_VERSION;
  filename: string;
  bytes: number;
  sha256: string;
  tableCount: number;
  rowCount: number;
  tables: readonly ArchivedRetiredTable[];
  integrity: "ok";
}

export interface TursoUploadPragmas {
  pageSize: 4096;
  journalMode: "delete" | "wal" | "mvcc";
  autoVacuum: 0;
  encoding: "UTF-8";
}

export interface D1NormalizationReceipt {
  sourceFilename: string;
  sourceBytes: number;
  sourceSha256: string;
  schemaUpgrade: SqliteSnapshotSchemaUpgradeReceipt;
  tableCount: number;
  rowCount: number;
  discardedColumns: readonly string[];
  ignoredSourceTables: readonly IgnoredSourceTable[];
  retiredSchemaArchive: RetiredSchemaArchiveReceipt | null;
  normalizedValueCount: number;
  foreignKeyViolations: 0;
  integrity: "ok";
  portabilityManifest: SqlitePortabilityManifest;
  uploadPragmas: TursoUploadPragmas;
}

export const SQLITE_SNAPSHOT_SCHEMA_UPGRADE_VERSION =
  "scalius-sqlite-snapshot-schema-upgrade/v1" as const;

export interface AppliedSqliteSnapshotMigration {
  name: string;
  sourceSha256: string;
  compiledSha256: string;
}

export interface SqliteSnapshotSchemaUpgradeReceipt {
  version: typeof SQLITE_SNAPSHOT_SCHEMA_UPGRADE_VERSION;
  provider: "d1" | "turso";
  sourceMigrationCount: number;
  targetMigrationCount: number;
  sourceSchemaSha256: string;
  targetSchemaSha256: string;
  sourceDatabaseBytes: number;
  sourceDatabaseSha256: string;
  upgradedDatabaseBytes: number;
  upgradedDatabaseSha256: string;
  appliedMigrations: readonly AppliedSqliteSnapshotMigration[];
  integrity: "ok";
  foreignKeyViolations: 0;
}

export interface NormalizeD1ExportOptions {
  input: string;
  targetDatabasePath: string;
  sqliteBinary: string;
  retiredSchemaArchivePath?: string;
}

export interface NormalizeSqliteDatabaseOptions {
  sourcePath: string;
  sourceFilename?: string;
  sourceBytes: number;
  sourceSha256: string;
  sourceDatabaseBytes?: number;
  sourceDatabaseSha256?: string;
  targetDatabasePath: string;
  targetJournalMode?: "delete" | "wal";
  retiredSchemaArchivePath?: string;
  sourceProvider?: Extract<DatabaseProvider, "d1" | "turso">;
}

export function verifyRetiredSchemaArchiveContents(
  archivePath: string,
  receipt: RetiredSchemaArchiveReceipt,
): void {
  const archive = new DatabaseSync(archivePath, { readOnly: true });
  try {
    const integrity = String(
      archive.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
    ).toLowerCase();
    if (integrity !== "ok") {
      throw new Error("Retired schema archive failed SQLite integrity_check.");
    }

    const expectedTables = [...receipt.tables]
      .sort((left, right) => left.table.localeCompare(right.table));
    const expectedNames = [
      "_scalius_retired_schema_objects",
      "_scalius_retired_schema_tables",
      ...expectedTables.map(({ table }) => table),
    ].sort();
    const actualNames = archive.prepare(`
      SELECT name
      FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
      throw new Error("Retired schema archive contains an unexpected table set.");
    }

    const seen = new Set<string>();
    for (const expected of expectedTables) {
      if (
        seen.has(expected.table)
        || !isRetiredSourceTable(expected.table)
        || expected.rowCount <= 0
      ) {
        throw new Error("Retired schema archive contains invalid table evidence.");
      }
      seen.add(expected.table);
      const manifest = archive.prepare(`
        SELECT row_count, content_sha256, create_sql
        FROM _scalius_retired_schema_tables
        WHERE table_name = ?
      `).get(expected.table);
      const schema = archive.prepare(`
        SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?
      `).get(expected.table);
      const actual = fingerprintRetiredTable(archive, expected.table);
      if (
        Number(manifest?.row_count ?? -1) !== expected.rowCount
        || String(manifest?.content_sha256 ?? "") !== expected.contentSha256
        || String(manifest?.create_sql ?? "").trim() !== String(schema?.sql ?? "").trim()
        || actual.rowCount !== expected.rowCount
        || actual.contentSha256 !== expected.contentSha256
      ) {
        throw new Error(
          `Retired schema archive content fingerprint differs for ${expected.table}.`,
        );
      }

      const storedObjects = archive.prepare(`
        SELECT object_type, object_name, object_sql
        FROM _scalius_retired_schema_objects
        WHERE table_name = ?
        ORDER BY object_type, object_name
      `).all(expected.table);
      const activeObjects = archive.prepare(`
        SELECT type AS object_type, name AS object_name, sql AS object_sql
        FROM sqlite_schema
        WHERE tbl_name = ?
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
        ORDER BY type, name
      `).all(expected.table);
      const expectedActiveObjects = storedObjects.filter(
        (object) => String(object.object_type) === "index",
      );
      if (
        storedObjects.some((object) =>
          object.object_type !== "index" && object.object_type !== "trigger")
        || JSON.stringify(activeObjects) !== JSON.stringify(expectedActiveObjects)
      ) {
        throw new Error(
          `Retired schema archive object evidence differs for ${expected.table}.`,
        );
      }
    }
    const manifestCount = Number(archive.prepare(`
      SELECT COUNT(*) AS count FROM _scalius_retired_schema_tables
    `).get()?.count ?? -1);
    const manifestRows = Number(archive.prepare(`
      SELECT COALESCE(SUM(row_count), 0) AS count
      FROM _scalius_retired_schema_tables
    `).get()?.count ?? -1);
    if (
      manifestCount !== receipt.tableCount
      || manifestCount !== expectedTables.length
      || manifestRows !== receipt.rowCount
    ) {
      throw new Error("Retired schema archive manifest totals differ from evidence.");
    }
  } finally {
    archive.close();
  }
}

/**
 * Tables from the pre-consolidation schema that have no owner in the current
 * application. Empty instances may be retired while normalizing to the
 * canonical schema. Non-empty instances must be archived explicitly first;
 * migration must never turn schema cleanup into silent data loss.
 */
export const RETIRED_PRE_CONSOLIDATION_TABLES: ReadonlySet<string> = new Set([
  "abandoned_cart_emails",
  "blog_categories",
  "blog_posts",
  "customer_group_members",
  "customer_groups",
  "customer_tag_assignments",
  "customer_tags",
  "plugin_data",
  "plugin_hooks",
  "plugin_logs",
  "plugin_routes",
  "plugin_settings",
  "plugin_sources",
  "plugin_state",
  "redirects",
  "tax_rules",
  "webhook_deliveries",
  "webhook_endpoints",
] as const);

/**
 * Disposable concurrency-rehearsal tables created against the hosted demo
 * before the load harness moved to uniquely named, isolated targets. They are
 * not application authority, but non-empty instances are still archived with
 * exact schema/content fingerprints instead of being silently discarded.
 */
export const RETIRED_LOAD_REHEARSAL_TABLES: ReadonlySet<string> = new Set([
  "scalius_turso_control_a",
  "scalius_turso_control_b",
  "scalius_turso_control_steps",
] as const);

function isRetiredSourceTable(table: string): boolean {
  return RETIRED_PRE_CONSOLIDATION_TABLES.has(table)
    || RETIRED_LOAD_REHEARSAL_TABLES.has(table);
}

const MINIMUM_PORTABLE_SOURCE_MIGRATION_COUNT = 46;

interface CanonicalSqliteMigration {
  name: string;
  source: string;
  sourceSha256: string;
  compiled: string;
  compiledSha256: string;
}

interface SqliteSchemaFingerprint {
  sha256: string;
  objectCount: number;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * TursoDB reparses and reserializes sqlite_schema SQL (case, whitespace, and
 * punctuation spacing change). Tokenizing the definition compares SQLite
 * semantics while preserving string literals and operators, so a provider
 * rewrite cannot hide a real schema change or create a false version miss.
 */
export function canonicalizeSqliteSchemaDefinition(input: string): string {
  const tokens: string[] = [];
  let index = 0;
  while (index < input.length) {
    const character = input[index]!;
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && input[index + 1] === "-") {
      index += 2;
      while (index < input.length && input[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && input[index + 1] === "*") {
      const end = input.indexOf("*/", index + 2);
      if (end < 0) throw new Error("SQLite schema SQL contains an unterminated comment.");
      index = end + 2;
      continue;
    }
    if (character === "'") {
      let literal = "";
      index += 1;
      let closed = false;
      while (index < input.length) {
        const next = input[index]!;
        if (next === "'" && input[index + 1] === "'") {
          literal += "''";
          index += 2;
          continue;
        }
        if (next === "'") {
          index += 1;
          closed = true;
          break;
        }
        literal += next;
        index += 1;
      }
      if (!closed) throw new Error("SQLite schema SQL contains an unterminated string.");
      tokens.push(`s:${literal}`);
      continue;
    }
    if (character === "`" || character === '"' || character === "[") {
      const close = character === "[" ? "]" : character;
      let identifier = "";
      index += 1;
      let closed = false;
      while (index < input.length) {
        const next = input[index]!;
        if (next === close && character !== "[" && input[index + 1] === close) {
          identifier += close;
          index += 2;
          continue;
        }
        if (next === close) {
          index += 1;
          closed = true;
          break;
        }
        identifier += next;
        index += 1;
      }
      if (!closed) throw new Error("SQLite schema SQL contains an unterminated identifier.");
      tokens.push(`i:${identifier.toLowerCase()}`);
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(character)) {
      const start = index;
      index += 1;
      while (index < input.length && /[A-Za-z0-9_$]/.test(input[index]!)) index += 1;
      tokens.push(`i:${input.slice(start, index).toLowerCase()}`);
      continue;
    }
    const three = input.slice(index, index + 3);
    const two = input.slice(index, index + 2);
    if (three === "->>") {
      tokens.push("o:->>");
      index += 3;
    } else if ([">=", "<=", "<>", "!=", "==", "||", "->"].includes(two)) {
      tokens.push(two === "<>" || two === "!=" ? "o:ne" : `o:${two}`);
      index += 2;
    } else {
      tokens.push(`p:${character}`);
      index += 1;
    }
  }
  return JSON.stringify(tokens);
}

function isExcludedSnapshotSchemaObject(name: string, table: string): boolean {
  return [name, table].some((candidate) =>
    isProviderDerivedSourceTable(candidate)
    || isRetiredSourceTable(candidate)
    || EMPTY_PROVIDER_SNAPSHOT_TRANSIENT_TABLES.has(candidate));
}

function fingerprintCanonicalSnapshotSchema(
  database: DatabaseSync,
): SqliteSchemaFingerprint {
  const objects = database.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL
    ORDER BY type, name
  `).all()
    .map((row) => ({
      type: String(row.type),
      name: String(row.name),
      table: String(row.tbl_name),
      sql: String(row.sql),
    }))
    .filter(({ name, table }) =>
      !isExcludedSnapshotSchemaObject(name, table))
    .map((object) => ({
      type: object.type,
      name: object.name,
      table: object.table,
      definition: object.type === "table"
        ? readSemanticSqliteTableDefinition(database, object.name, object.sql)
        : canonicalizeSqliteSchemaDefinition(object.sql),
    }));
  return {
    sha256: sha256Text(JSON.stringify(objects)),
    objectCount: objects.length,
  };
}

function extractCanonicalCheckExpressions(sql: string): readonly string[] {
  const tokens = JSON.parse(canonicalizeSqliteSchemaDefinition(sql)) as string[];
  const checks: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "i:check" || tokens[index + 1] !== "p:(") continue;
    const expression: string[] = [];
    let depth = 0;
    for (index += 1; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === "p:(") depth += 1;
      if (token === "p:)") depth -= 1;
      expression.push(token);
      if (depth === 0) break;
    }
    if (depth !== 0) throw new Error("SQLite table CHECK expression is unbalanced.");
    checks.push(JSON.stringify(expression));
  }
  return checks.sort();
}

function readSemanticSqliteTableDefinition(
  database: DatabaseSync,
  table: string,
  createSql: string,
): Record<string, unknown> {
  const columns = database.prepare(
    `PRAGMA table_xinfo(${quoteIdentifier(table)})`,
  ).all().map((row) => ({
    cid: Number(row.cid),
    name: String(row.name).toLowerCase(),
    type: String(row.type ?? "").trim().toLowerCase().replace(/\s+/g, " "),
    notNull: Number(row.notnull),
    defaultValue: row.dflt_value == null
      ? null
      : canonicalizeSqliteSchemaDefinition(String(row.dflt_value)),
    primaryKeyPosition: Number(row.pk),
    hidden: Number(row.hidden ?? 0),
  }));
  const foreignKeyRows = database.prepare(
    `PRAGMA foreign_key_list(${quoteIdentifier(table)})`,
  ).all().map((row) => ({
    id: Number(row.id),
    sequence: Number(row.seq),
    targetTable: String(row.table).toLowerCase(),
    sourceColumn: String(row.from).toLowerCase(),
    targetColumn: row.to == null ? null : String(row.to).toLowerCase(),
    onUpdate: String(row.on_update).toLowerCase(),
    onDelete: String(row.on_delete).toLowerCase(),
    match: String(row.match).toLowerCase(),
  }));
  const foreignKeyGroups = new Map<number, typeof foreignKeyRows>();
  for (const row of foreignKeyRows) {
    const group = foreignKeyGroups.get(row.id) ?? [];
    group.push(row);
    foreignKeyGroups.set(row.id, group);
  }
  const foreignKeys = [...foreignKeyGroups.values()].map((group) =>
    group.sort((left, right) => left.sequence - right.sequence).map((row) => ({
      sequence: row.sequence,
      targetTable: row.targetTable,
      sourceColumn: row.sourceColumn,
      targetColumn: row.targetColumn,
      onUpdate: row.onUpdate,
      onDelete: row.onDelete,
      match: row.match,
    }))).sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const automaticIndexes = database.prepare(
    `PRAGMA index_list(${quoteIdentifier(table)})`,
  ).all().filter((row) => {
    const schema = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
    ).get(String(row.name));
    return schema?.sql == null;
  }).map((row) => ({
    unique: Number(row.unique),
    origin: String(row.origin).toLowerCase(),
    partial: Number(row.partial),
    columns: database.prepare(
      `PRAGMA index_xinfo(${quoteIdentifier(String(row.name))})`,
    ).all().map((column) => ({
      sequence: Number(column.seqno),
      cid: Number(column.cid),
      name: column.name == null ? null : String(column.name).toLowerCase(),
      descending: Number(column.desc),
      collation: column.coll == null ? null : String(column.coll).toLowerCase(),
      key: Number(column.key),
    })),
  })).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const tableList = database.prepare(`
    PRAGMA table_list
  `).all().find((row) => String(row.name) === table);
  const tokens = JSON.parse(
    canonicalizeSqliteSchemaDefinition(createSql),
  ) as string[];
  const collations = tokens.flatMap((token, index) =>
    token === "i:collate" && tokens[index + 1]
      ? [tokens[index + 1]!]
      : []).sort();
  return {
    columns,
    foreignKeys,
    automaticIndexes,
    checks: extractCanonicalCheckExpressions(createSql),
    collations,
    autoIncrement: tokens.includes("i:autoincrement"),
    strict: Number(tableList?.strict ?? 0),
    withoutRowId: Number(tableList?.wr ?? 0),
  };
}

async function readCanonicalSqliteMigrations(
  provider: Extract<DatabaseProvider, "d1" | "turso">,
): Promise<readonly CanonicalSqliteMigration[]> {
  const names = (await readdir(canonicalMigrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (names.length === 0) {
    throw new Error("No canonical SQLite migrations were found.");
  }
  return Promise.all(names.map(async (name) => {
    const source = await readFile(join(canonicalMigrationDirectory, name), "utf8");
    const compiled = compileSqliteMigrationForProvider(source, provider);
    return {
      name,
      source,
      sourceSha256: sha256Text(source),
      compiled,
      compiledSha256: sha256Text(compiled),
    };
  }));
}

async function upgradeSqliteSnapshotSchema(
  databasePath: string,
  provider: Extract<DatabaseProvider, "d1" | "turso">,
  sourceDatabaseBytes: number,
  sourceDatabaseSha256: string,
): Promise<SqliteSnapshotSchemaUpgradeReceipt> {
  const migrations = await readCanonicalSqliteMigrations(provider);
  const source = new DatabaseSync(databasePath);
  const canonical = new DatabaseSync(":memory:");
  let transactionOpen = false;
  try {
    const sourceSchema = fingerprintCanonicalSnapshotSchema(source);
    const matches: number[] = [];
    let targetSchema: SqliteSchemaFingerprint | undefined;
    for (let migrationCount = 0; migrationCount <= migrations.length; migrationCount += 1) {
      const fingerprint = fingerprintCanonicalSnapshotSchema(canonical);
      if (fingerprint.sha256 === sourceSchema.sha256) matches.push(migrationCount);
      if (migrationCount === migrations.length) {
        targetSchema = fingerprint;
        break;
      }
      canonical.exec(migrations[migrationCount]!.compiled);
    }
    if (matches.length !== 1) {
      const canonicalTables = new Set(canonical.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table'
      `).all().map((row) => String(row.name)));
      const unexpectedTables = source.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all()
        .map((row) => String(row.name))
        .filter((table) =>
          !canonicalTables.has(table)
          && !isExcludedSnapshotSchemaObject(table, table));
      if (unexpectedTables.length > 0) {
        throw new Error(
          `Source export contains unexpected noncanonical tables: ${unexpectedTables.join(", ")}.`,
        );
      }
      throw new Error(
        matches.length === 0
          ? "SQLite source schema does not match any canonical migration boundary."
          : "SQLite source schema ambiguously matches several canonical migration boundaries.",
      );
    }
    const sourceMigrationCount = matches[0]!;
    if (sourceMigrationCount < MINIMUM_PORTABLE_SOURCE_MIGRATION_COUNT) {
      throw new Error(
        `SQLite source schema is at migration ${sourceMigrationCount}, below the portable baseline `
        + `${MINIMUM_PORTABLE_SOURCE_MIGRATION_COUNT}. Apply the supported baseline first.`,
      );
    }
    const applied = migrations.slice(sourceMigrationCount);
    if (applied.some(({ compiled }) => /^\s*PRAGMA\s+foreign_keys\b/im.test(compiled))) {
      throw new Error(
        "A pending SQLite migration changes foreign_keys and cannot be applied atomically to a portable snapshot.",
      );
    }
    if (applied.length > 0) {
      source.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;");
      transactionOpen = true;
      for (const migration of applied) source.exec(migration.compiled);
      source.exec("COMMIT;");
      transactionOpen = false;
    }
    const upgradedSchema = fingerprintCanonicalSnapshotSchema(source);
    if (
      !targetSchema
      || upgradedSchema.sha256 !== targetSchema.sha256
      || upgradedSchema.objectCount !== targetSchema.objectCount
    ) {
      throw new Error("SQLite snapshot schema upgrade did not reach the canonical target schema.");
    }
    const integrity = String(
      source.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
    ).toLowerCase();
    const foreignKeys = source.prepare("PRAGMA foreign_key_check").all();
    if (integrity !== "ok" || foreignKeys.length > 0) {
      throw new Error("SQLite snapshot schema upgrade failed integrity verification.");
    }
    source.close();
    canonical.close();
    const upgradedDatabase = await sha256Archive(databasePath);
    return {
      version: SQLITE_SNAPSHOT_SCHEMA_UPGRADE_VERSION,
      provider,
      sourceMigrationCount,
      targetMigrationCount: migrations.length,
      sourceSchemaSha256: sourceSchema.sha256,
      targetSchemaSha256: targetSchema.sha256,
      sourceDatabaseBytes,
      sourceDatabaseSha256,
      upgradedDatabaseBytes: upgradedDatabase.bytes,
      upgradedDatabaseSha256: upgradedDatabase.sha256,
      appliedMigrations: applied.map(({ name, sourceSha256, compiledSha256 }) => ({
        name,
        sourceSha256,
        compiledSha256,
      })),
      integrity: "ok",
      foreignKeyViolations: 0,
    };
  } catch (error) {
    if (transactionOpen) source.exec("ROLLBACK;");
    throw error;
  } finally {
    try {
      source.close();
    } catch {
      // Closed before hashing a successful upgrade.
    }
    try {
      canonical.close();
    } catch {
      // Closed before hashing a successful upgrade.
    }
  }
}

/**
 * The new TursoDB sync bootstrap currently exposes this already-dropped table
 * recreation name in the local snapshot even though the remote sqlite_schema
 * contains only `rate_limit`. It is safe to omit only while it is empty; a row
 * must stop migration instead of being mistaken for provider metadata.
 */
export const EMPTY_PROVIDER_SNAPSHOT_TRANSIENT_TABLES: ReadonlySet<string> =
  new Set(["__new_rate_limit"] as const);

const LEGACY_UTC_TEXT_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set([
  "delivery_locations.created_at",
  "delivery_locations.updated_at",
  "hero_sliders.created_at",
  "settings.updated_at",
] as const);

function isLegacyUtcTextTimestampColumn(table: string, column: string): boolean {
  return LEGACY_UTC_TEXT_TIMESTAMP_COLUMNS.has(`${table}.${column}`);
}

/** Deterministic compatibility projections for proven pre-baseline data. */
function legacyProjection(table: string, column: string): string | undefined {
  if (table === "permissions" && column === "updated_at") {
    return 'COALESCE("updated_at", "created_at")';
  }
  if (isLegacyUtcTextTimestampColumn(table, column)) {
    const quoted = quoteIdentifier(column);
    return `CASE WHEN typeof(${quoted}) = 'text' THEN unixepoch(${quoted}) ELSE ${quoted} END`;
  }
  return undefined;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function isProviderDerivedSourceTable(table: string): boolean {
  return (
    /_fts(?:_|$)/i.test(table) ||
    /^(?:_cf_|__turso_|libsql_|sqlite_)/i.test(table) ||
    /^(?:turso_cdc|turso_cdc_version|turso_sync_last_change_id)$/i.test(table) ||
    table === "d1_migrations"
  );
}

function readColumns(
  database: DatabaseSync,
  schema: "main" | "source",
  table: string,
): readonly TableColumn[] {
  return database.prepare(
    `PRAGMA ${schema}.table_info(${quoteIdentifier(table)})`,
  ).all().map((row) => ({
    name: String(row.name),
    notNull: Number(row.notnull) === 1,
  }));
}

function createNodeSqliteExecutor(database: DatabaseSync): SqlitePortabilityExecutor {
  return {
    async query(sql, params = []) {
      const normalizedParams = params.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      );
      return database.prepare(sql).all(
        ...normalizedParams,
      ) as Record<string, unknown>[];
    },
  };
}

async function removeSqliteFiles(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
  ]);
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(`Refusing to overwrite retired schema archive ${path}.`);
}

function updateArchiveFingerprintPart(
  hash: Hash,
  tag: string,
  payload: string | Uint8Array = "",
): void {
  const tagBytes = Buffer.from(tag, "utf8");
  if (tagBytes.byteLength !== 1) {
    throw new Error("Retired schema archive fingerprint tags must be one byte.");
  }
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(tagBytes);
  hash.update(length);
  hash.update(bytes);
}

interface RetiredTableColumn {
  name: string;
  declaredType: string;
  primaryKeyPosition: number;
}

function readRetiredTableColumns(
  database: DatabaseSync,
  table: string,
): readonly RetiredTableColumn[] {
  const columns = database.prepare(
    `PRAGMA table_info(${quoteIdentifier(table)})`,
  ).all().map((row) => ({
    name: String(row.name),
    declaredType: String(row.type ?? ""),
    primaryKeyPosition: Number(row.pk ?? 0),
  }));
  if (columns.length === 0) {
    throw new Error(`Retired table ${JSON.stringify(table)} has no visible columns.`);
  }
  return columns;
}

function retiredTableOrder(columns: readonly RetiredTableColumn[]): string {
  const primaryKey = columns
    .filter((column) => column.primaryKeyPosition > 0)
    .sort((left, right) => left.primaryKeyPosition - right.primaryKeyPosition);
  return primaryKey.length > 0
    ? primaryKey.map((column) => quoteIdentifier(column.name)).join(", ")
    : "rowid";
}

function updateArchiveValue(hash: Hash, value: unknown, column: string): void {
  if (value === null) {
    updateArchiveFingerprintPart(hash, "N");
    return;
  }
  if (typeof value === "string") {
    updateArchiveFingerprintPart(hash, "S", value);
    return;
  }
  if (typeof value === "bigint") {
    updateArchiveFingerprintPart(hash, "I", value.toString());
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Retired table column ${column} contains a non-finite number.`);
    }
    const bytes = Buffer.allocUnsafe(8);
    bytes.writeDoubleBE(value);
    updateArchiveFingerprintPart(hash, "R", bytes);
    return;
  }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    updateArchiveFingerprintPart(hash, "B", bytes);
    return;
  }
  throw new Error(
    `Retired table column ${column} contains unsupported ${typeof value} data.`,
  );
}

function fingerprintRetiredTable(
  database: DatabaseSync,
  table: string,
): ArchivedRetiredTable {
  const columns = readRetiredTableColumns(database, table);
  const columnSql = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const statement = database.prepare(
    `SELECT ${columnSql} FROM ${quoteIdentifier(table)} `
    + `ORDER BY ${retiredTableOrder(columns)}`,
  );
  statement.setReadBigInts(true);
  const hash = createHash("sha256");
  updateArchiveFingerprintPart(hash, "V", RETIRED_SCHEMA_ARCHIVE_VERSION);
  updateArchiveFingerprintPart(hash, "T", table);
  for (const column of columns) {
    updateArchiveFingerprintPart(hash, "C", column.name);
    updateArchiveFingerprintPart(hash, "Y", column.declaredType);
  }
  let rowCount = 0;
  for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
    updateArchiveFingerprintPart(hash, "[", String(rowCount));
    for (const column of columns) {
      updateArchiveValue(hash, row[column.name], `${table}.${column.name}`);
    }
    updateArchiveFingerprintPart(hash, "]");
    rowCount += 1;
  }
  return { table, rowCount, contentSha256: hash.digest("hex") };
}

async function sha256Archive(path: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function assertSqliteSourceEvidence(
  path: string,
  expectedBytes: number,
  expectedSha256: string,
): Promise<void> {
  const source = await stat(path);
  if (!source.isFile() || source.size !== expectedBytes) {
    throw new Error("SQLite normalization source differs from its size evidence.");
  }
  for (const suffix of ["-journal", "-shm", "-wal"]) {
    try {
      await access(`${path}${suffix}`);
    } catch {
      continue;
    }
    throw new Error(
      `SQLite normalization source has a ${suffix.slice(1)} sidecar; `
      + "checkpoint it into one immutable file first.",
    );
  }
  if ((await sha256Archive(path)).sha256 !== expectedSha256) {
    throw new Error("SQLite normalization source differs from its SHA-256 evidence.");
  }
}

async function archiveRetiredTables(
  sourcePath: string,
  archivePath: string,
  tables: readonly IgnoredSourceTable[],
): Promise<RetiredSchemaArchiveReceipt> {
  const resolvedArchivePath = resolve(archivePath);
  if (resolvedArchivePath === resolve(sourcePath)) {
    throw new Error("Retired schema archive must not overwrite its SQLite source.");
  }
  await assertMissing(resolvedArchivePath);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const archive = new DatabaseSync(resolvedArchivePath);
  let transactionOpen = false;
  let succeeded = false;
  try {
    archive.exec(`
      PRAGMA page_size=4096;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=OFF;
      CREATE TABLE _scalius_retired_schema_tables (
        table_name TEXT PRIMARY KEY,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        content_sha256 TEXT NOT NULL CHECK (
          length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
        create_sql TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE _scalius_retired_schema_objects (
        table_name TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_name TEXT NOT NULL,
        object_sql TEXT NOT NULL,
        PRIMARY KEY (table_name, object_type, object_name),
        FOREIGN KEY (table_name)
          REFERENCES _scalius_retired_schema_tables (table_name)
      ) WITHOUT ROWID;
    `);
    archive.prepare("ATTACH DATABASE ? AS source").run(sourcePath);
    archive.exec("BEGIN IMMEDIATE;");
    transactionOpen = true;
    const receipts: ArchivedRetiredTable[] = [];
    for (const expected of [...tables].sort((left, right) =>
      left.table.localeCompare(right.table))) {
      const schema = source.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(expected.table);
      const createSql = typeof schema?.sql === "string" ? schema.sql.trim() : "";
      if (!createSql) {
        throw new Error(`Retired table ${JSON.stringify(expected.table)} lacks CREATE SQL.`);
      }
      archive.exec(createSql);
      const columns = readRetiredTableColumns(source, expected.table);
      const names = columns.map((column) => column.name);
      const columnSql = names.map(quoteIdentifier).join(", ");
      // Keep database-sized copies inside SQLite instead of materializing rows
      // in JavaScript. Ordering preserves deterministic rowid traversal for
      // legacy tables without an explicit primary key.
      archive.exec(
        `INSERT INTO main.${quoteIdentifier(expected.table)} (${columnSql}) `
        + `SELECT ${columnSql} FROM source.${quoteIdentifier(expected.table)} `
        + `ORDER BY ${retiredTableOrder(columns)}`,
      );

      const objects = source.prepare(`
        SELECT type, name, sql
        FROM sqlite_schema
        WHERE tbl_name = ?
          AND type IN ('index', 'trigger')
          AND sql IS NOT NULL
        ORDER BY type, name
      `).all(expected.table);
      for (const object of objects) {
        const type = String(object.type);
        const name = String(object.name);
        const sql = String(object.sql);
        if (type === "index") archive.exec(sql);
        archive.prepare(`
          INSERT INTO _scalius_retired_schema_objects
            (table_name, object_type, object_name, object_sql)
          VALUES (?, ?, ?, ?)
        `).run(expected.table, type, name, sql);
      }

      const sourceFingerprint = fingerprintRetiredTable(source, expected.table);
      const archiveFingerprint = fingerprintRetiredTable(archive, expected.table);
      if (
        sourceFingerprint.rowCount !== expected.rowCount
        || archiveFingerprint.rowCount !== sourceFingerprint.rowCount
        || archiveFingerprint.contentSha256 !== sourceFingerprint.contentSha256
      ) {
        throw new Error(
          `Retired table archive fingerprint differs for ${expected.table}.`,
        );
      }
      archive.prepare(`
        INSERT INTO _scalius_retired_schema_tables
          (table_name, row_count, content_sha256, create_sql)
        VALUES (?, ?, ?, ?)
      `).run(
        expected.table,
        expected.rowCount,
        sourceFingerprint.contentSha256,
        createSql,
      );
      receipts.push(sourceFingerprint);
    }
    archive.exec("COMMIT;");
    transactionOpen = false;
    archive.exec("DETACH DATABASE source;");
    const integrity = String(
      archive.prepare("PRAGMA integrity_check").get()?.integrity_check ?? "",
    ).toLowerCase();
    if (integrity !== "ok") {
      throw new Error("Retired schema archive failed SQLite integrity_check.");
    }
    archive.exec("VACUUM;");
    archive.close();
    source.close();
    await chmod(resolvedArchivePath, 0o600);
    const artifact = await sha256Archive(resolvedArchivePath);
    succeeded = true;
    return {
      version: RETIRED_SCHEMA_ARCHIVE_VERSION,
      filename: basename(resolvedArchivePath),
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      tableCount: receipts.length,
      rowCount: receipts.reduce((sum, table) => sum + table.rowCount, 0),
      tables: receipts,
      integrity: "ok",
    };
  } catch (error) {
    if (transactionOpen) archive.exec("ROLLBACK;");
    throw error;
  } finally {
    try {
      archive.close();
    } catch {
      // It was already closed after a successful durable archive.
    }
    try {
      source.close();
    } catch {
      // It was already closed after a successful durable archive.
    }
    if (!succeeded) await removeSqliteFiles(resolvedArchivePath);
  }
}

export async function normalizeSqliteDatabaseToTursoDatabase(
  options: NormalizeSqliteDatabaseOptions,
): Promise<D1NormalizationReceipt> {
  if (resolve(options.sourcePath) === resolve(options.targetDatabasePath)) {
    throw new Error("SQLite normalization source and target must be separate files.");
  }
  if (
    !Number.isSafeInteger(options.sourceBytes)
    || options.sourceBytes < 0
    || !/^[a-f0-9]{64}$/.test(options.sourceSha256)
    || (
      options.sourceDatabaseBytes !== undefined
      && (
        !Number.isSafeInteger(options.sourceDatabaseBytes)
        || options.sourceDatabaseBytes < 0
      )
    )
    || (
      options.sourceDatabaseSha256 !== undefined
      && !/^[a-f0-9]{64}$/.test(options.sourceDatabaseSha256)
    )
  ) {
    throw new Error("SQLite normalization source evidence is invalid.");
  }
  const originalSourceDatabaseBytes = options.sourceDatabaseBytes ?? options.sourceBytes;
  const originalSourceDatabaseSha256 =
    options.sourceDatabaseSha256 ?? options.sourceSha256;
  await assertSqliteSourceEvidence(
    options.sourcePath,
    originalSourceDatabaseBytes,
    originalSourceDatabaseSha256,
  );
  const schemaUpgrade = await upgradeSqliteSnapshotSchema(
    options.sourcePath,
    options.sourceProvider ?? "d1",
    originalSourceDatabaseBytes,
    originalSourceDatabaseSha256,
  );
  const sourceDatabaseBytes = schemaUpgrade.upgradedDatabaseBytes;
  const sourceDatabaseSha256 = schemaUpgrade.upgradedDatabaseSha256;
  let target: DatabaseSync | undefined;
  let succeeded = false;

  try {
    target = await createProviderSchemaDatabase(
      "turso",
      options.targetDatabasePath,
    );
    let tableCount = 0;
    let rowCount = 0;
    const discardedColumns: string[] = [];
    let ignoredSourceTables: IgnoredSourceTable[] = [];
    let retiredSchemaArchive: RetiredSchemaArchiveReceipt | null = null;
    let normalizedValueCount = 0;

    const triggers = readFinalTriggerDefinitions(target);
    target.exec("PRAGMA foreign_keys=OFF;");
    dropTriggers(target, triggers);
    target.prepare("ATTACH DATABASE ? AS source").run(options.sourcePath);

    const tables = target.prepare(`
      SELECT name
      FROM main.sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map((row) => String(row.name));
    const targetTableNames = new Set(tables);
    ignoredSourceTables = target.prepare(`
      SELECT name
      FROM source.sqlite_schema
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()
      .map((row) => String(row.name))
      .filter((table) => !targetTableNames.has(table))
      .filter((table) => !isProviderDerivedSourceTable(table))
      .map((table) => ({
        table,
        rowCount: Number(target!.prepare(
          `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)}`,
        ).get()?.count ?? 0),
      }));
    const unexpectedSourceTables = ignoredSourceTables.filter(
      ({ table }) =>
        !isRetiredSourceTable(table)
        && !EMPTY_PROVIDER_SNAPSHOT_TRANSIENT_TABLES.has(table),
    );
    if (unexpectedSourceTables.length > 0) {
      throw new Error(
        "Source export contains unexpected noncanonical tables: "
        + unexpectedSourceTables.map(({ table, rowCount }) =>
          `${table} (${rowCount} rows)`).join(", "),
      );
    }
    const nonEmptySnapshotTransients = ignoredSourceTables.filter(
      ({ table, rowCount }) =>
        EMPTY_PROVIDER_SNAPSHOT_TRANSIENT_TABLES.has(table) && rowCount > 0,
    );
    if (nonEmptySnapshotTransients.length > 0) {
      throw new Error(
        "Provider snapshot transient tables unexpectedly contain data: "
        + nonEmptySnapshotTransients.map(({ table, rowCount }) =>
          `${table} (${rowCount} rows)`).join(", "),
      );
    }
    const nonEmptyRetiredTables = ignoredSourceTables.filter(
      ({ table, rowCount }) =>
        isRetiredSourceTable(table) && rowCount > 0,
    );
    if (nonEmptyRetiredTables.length > 0) {
      if (!options.retiredSchemaArchivePath) {
        throw new Error(
          "Source export contains non-empty retired tables that require an explicit archive: "
          + nonEmptyRetiredTables.map(({ table, rowCount }) =>
            `${table} (${rowCount} rows)`).join(", "),
        );
      }
      if (
        resolve(options.retiredSchemaArchivePath)
        === resolve(options.targetDatabasePath)
      ) {
        throw new Error("Retired schema archive must be separate from the canonical database.");
      }
      retiredSchemaArchive = await archiveRetiredTables(
        options.sourcePath,
        options.retiredSchemaArchivePath,
        nonEmptyRetiredTables,
      );
    }

    const tablePlans: TablePlan[] = [];
    const nullabilityIssues: string[] = [];
    for (const table of tables) {
      const targetColumns = readColumns(target, "main", table);
      const sourceColumns = readColumns(target, "source", table);
      if (sourceColumns.length === 0) {
        throw new Error(`Source export is missing table ${JSON.stringify(table)}.`);
      }
      const sourceColumnsByName = new Map(
        sourceColumns.map((column) => [column.name, column]),
      );
      const missingColumns = targetColumns
        .map((column) => column.name)
        .filter((column) => !sourceColumnsByName.has(column));
      if (missingColumns.length > 0) {
        throw new Error(
          `Source table ${JSON.stringify(table)} is missing current columns: ${missingColumns.join(", ")}.`,
        );
      }
      for (const column of targetColumns) {
        if (isLegacyUtcTextTimestampColumn(table, column.name)) {
          const quotedColumn = quoteIdentifier(column.name);
          const invalidRows = Number(target.prepare(
            `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)} `
            + `WHERE ${quotedColumn} IS NOT NULL AND (`
            + `typeof(${quotedColumn}) NOT IN ('integer', 'text') OR (`
            + `typeof(${quotedColumn}) = 'text' AND (`
            + `unixepoch(${quotedColumn}) IS NULL OR `
            + `datetime(unixepoch(${quotedColumn}), 'unixepoch') IS NOT ${quotedColumn}`
            + `)))`,
          ).get()?.count ?? 0);
          if (invalidRows > 0) {
            throw new Error(
              `Legacy UTC timestamp ${table}.${column.name} contains ${invalidRows} invalid rows.`,
            );
          }
          normalizedValueCount += Number(target.prepare(
            `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)} `
            + `WHERE typeof(${quotedColumn}) = 'text'`,
          ).get()?.count ?? 0);
        }
        if (!column.notNull || sourceColumnsByName.get(column.name)?.notNull) {
          continue;
        }
        const nullRows = Number(target.prepare(
          `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)} `
          + `WHERE ${quoteIdentifier(column.name)} IS NULL`,
        ).get()?.count ?? 0);
        if (nullRows > 0) {
          if (legacyProjection(table, column.name)) {
            normalizedValueCount += nullRows;
          } else {
            nullabilityIssues.push(`${table}.${column.name} (${nullRows} rows)`);
          }
        }
      }
      tablePlans.push({ table, targetColumns, sourceColumns });
    }
    if (nullabilityIssues.length > 0) {
      throw new Error(
        `Source rows violate current NOT NULL constraints: ${nullabilityIssues.join(", ")}.`,
      );
    }

    target.exec("BEGIN;");
    try {
      for (const { table, targetColumns, sourceColumns } of tablePlans) {
        const targetColumnNames = new Set(
          targetColumns.map((column) => column.name),
        );
        discardedColumns.push(...sourceColumns
          .filter((column) => !targetColumnNames.has(column.name))
          .map((column) => `${table}.${column.name}`));

        const columnList = targetColumns
          .map((column) => quoteIdentifier(column.name))
          .join(", ");
        const projectionList = targetColumns
          .map((column) =>
            legacyProjection(table, column.name)
            ?? quoteIdentifier(column.name),
          )
          .join(", ");
        target.exec(`DELETE FROM main.${quoteIdentifier(table)};`);
        target.prepare(
          `INSERT INTO main.${quoteIdentifier(table)} (${columnList}) `
          + `SELECT ${projectionList} FROM source.${quoteIdentifier(table)}`,
        ).run();
        const sourceRows = Number(target.prepare(
          `SELECT COUNT(*) AS count FROM source.${quoteIdentifier(table)}`,
        ).get()?.count ?? 0);
        const targetRows = Number(target.prepare(
          `SELECT COUNT(*) AS count FROM main.${quoteIdentifier(table)}`,
        ).get()?.count ?? 0);
        if (sourceRows !== targetRows) {
          throw new Error(
            `Row-count mismatch while normalizing ${JSON.stringify(table)}.`,
          );
        }
        tableCount += 1;
        rowCount += targetRows;
      }
      restoreTriggers(target, triggers);
      target.exec("COMMIT;");
    } catch (error) {
      target.exec("ROLLBACK;");
      throw error;
    }

    target.exec("PRAGMA foreign_keys=ON;");
    const foreignKeyViolations = target
      .prepare("PRAGMA main.foreign_key_check")
      .all();
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `Normalized database has ${foreignKeyViolations.length} foreign-key violations.`,
      );
    }
    const integrity = String(
      target.prepare("PRAGMA main.integrity_check").get()?.integrity_check ?? "",
    );
    if (integrity !== "ok") {
      throw new Error("Normalized database failed SQLite integrity_check.");
    }
    target.exec("DETACH DATABASE source;");
    await assertSqliteSourceEvidence(
      options.sourcePath,
      sourceDatabaseBytes,
      sourceDatabaseSha256,
    );

    const portabilityManifest = await createSqlitePortabilityManifest(
      createNodeSqliteExecutor(target),
      { chunkSize: 1_000 },
    );
    const pageSize = Number(
      target.prepare("PRAGMA page_size").get()?.page_size ?? 0,
    );
    const autoVacuum = Number(
      target.prepare("PRAGMA auto_vacuum").get()?.auto_vacuum ?? -1,
    );
    const encoding = String(
      target.prepare("PRAGMA encoding").get()?.encoding ?? "",
    );
    if (pageSize !== 4096 || autoVacuum !== 0 || encoding !== "UTF-8") {
      throw new Error(
        `Turso upload file requirements are not satisfied: page_size=${pageSize}, auto_vacuum=${autoVacuum}, encoding=${encoding}.`,
      );
    }
    // Close the manifest connection before finalizing journal mode. Node's
    // prepared-statement finalizers otherwise keep transient read locks alive.
    target.close();
    target = undefined;
    const targetJournalMode = options.targetJournalMode ?? "wal";
    const uploadDatabase = new DatabaseSync(options.targetDatabasePath);
    try {
      if (targetJournalMode === "wal") {
        const journalMode = String(
          uploadDatabase.prepare("PRAGMA journal_mode=WAL").get()?.journal_mode ?? "",
        ).toLowerCase();
        if (journalMode !== "wal") {
          throw new Error(
            `Failed to enable WAL journal mode; received ${journalMode || "empty"}.`,
          );
        }
        const checkpoint = uploadDatabase
          .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
          .get();
        if (Number(checkpoint?.busy ?? 1) !== 0) {
          throw new Error(
            "SQLite WAL checkpoint remained busy while preparing upload file.",
          );
        }
      } else {
        const journalMode = String(
          uploadDatabase.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode ?? "",
        ).toLowerCase();
        if (journalMode !== "delete") {
          throw new Error(
            `Failed to enable DELETE journal mode; received ${journalMode || "empty"}.`,
          );
        }
      }
    } finally {
      uploadDatabase.close();
    }
    await chmod(options.targetDatabasePath, 0o600);

    const receipt: D1NormalizationReceipt = {
      sourceFilename: options.sourceFilename ?? basename(options.sourcePath),
      sourceBytes: options.sourceBytes,
      sourceSha256: options.sourceSha256,
      schemaUpgrade,
      tableCount,
      rowCount,
      discardedColumns,
      ignoredSourceTables,
      retiredSchemaArchive,
      normalizedValueCount,
      foreignKeyViolations: 0,
      integrity: "ok",
      portabilityManifest,
      uploadPragmas: {
        pageSize: 4096,
        journalMode: targetJournalMode,
        autoVacuum: 0,
        encoding: "UTF-8",
      },
    };
    succeeded = true;
    return receipt;
  } finally {
    target?.close();
    if (!succeeded) {
      await removeSqliteFiles(options.targetDatabasePath);
      if (options.retiredSchemaArchivePath) {
        await removeSqliteFiles(options.retiredSchemaArchivePath);
      }
    }
  }
}

export async function normalizeD1ExportToTursoDatabase(
  options: NormalizeD1ExportOptions,
): Promise<D1NormalizationReceipt> {
  const workingDirectory = await mkdtemp(
    join(dirname(options.targetDatabasePath), ".scalius-d1-normalize-"),
  );
  const sourcePath = join(workingDirectory, "source.sqlite3");
  try {
    const sourceLoad = await loadSqliteSqlFile(
      options.sqliteBinary,
      sourcePath,
      options.input,
    );
    const sourceDatabase = await sha256Archive(sourcePath);
    return await normalizeSqliteDatabaseToTursoDatabase({
      sourcePath,
      sourceFilename: basename(options.input),
      sourceBytes: sourceLoad.bytes,
      sourceSha256: sourceLoad.sha256,
      sourceDatabaseBytes: sourceDatabase.bytes,
      sourceDatabaseSha256: sourceDatabase.sha256,
      targetDatabasePath: options.targetDatabasePath,
      retiredSchemaArchivePath: options.retiredSchemaArchivePath,
    });
  } finally {
    await removeSqliteFiles(sourcePath);
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
