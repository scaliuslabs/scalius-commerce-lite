import {
  CURRENT_DATABASE_SCHEMA,
  CURRENT_DATABASE_SCHEMA_MIGRATIONS,
  DATABASE_SCHEMA_LEGACY_BASELINE,
  type DatabaseSchemaMigration,
  type DatabaseSchemaState,
} from "./schema-contract";
import { DRIZZLE_STATEMENT_BREAKPOINT } from "./migration-artifacts";
import {
  fingerprintSqlitePortableSchemaObjects,
  listSqlitePortableSchemaObjects,
  type SqlitePortabilityExecutor,
} from "./portability";
import {
  POSTGRES_MIGRATION_LOCK_KEY_SQL,
  POSTGRES_MIGRATION_STATE_REGCLASS,
  POSTGRES_MIGRATION_STATE_TABLE,
  postgresMigrationControlTable,
} from "./postgres-migration-control";

export const FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION = 50;
export const POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE = "P5001";
export const POSTGRES_SCHEMA_UPGRADE_BUSY_CODE = "P5002";

export interface SchemaUpgradeArtifact {
  version: number;
  name: string;
  sqliteStatements: readonly string[];
  postgresStatements: readonly string[];
  sourceSha256: string;
  tursoSha256: string;
  postgresSha256: string;
}

export interface SqliteSchemaCatalogRow {
  type: unknown;
  name: unknown;
  tableName: unknown;
  sql: unknown;
}

const SQLITE_SCHEMA_IGNORED_TABLES = new Set([
  "_cf_KV",
  "_litestream_lock",
  "d1_migrations",
]);

function requireMigrationIdentity(
  versionValue: unknown,
  nameValue: unknown,
  sourceSha256Value: unknown,
): DatabaseSchemaMigration {
  const version = Number(versionValue);
  const name = typeof nameValue === "string" ? nameValue : "";
  const sourceSha256 = typeof sourceSha256Value === "string"
    ? sourceSha256Value
    : "";
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || !name
    || !/^[a-f0-9]{64}$/.test(sourceSha256)
  ) {
    throw new Error("Database schema migration ledger contains an invalid row.");
  }
  return { version, name, sourceSha256 };
}

function isIgnoredSqliteSchemaObject(name: string): boolean {
  return SQLITE_SCHEMA_IGNORED_TABLES.has(name)
    || /_fts(?:_|$)/i.test(name)
    || /^(?:__turso_|libsql_|_litestream_|_cf_)/i.test(name);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function splitSchemaMigrationStatements(sql: string): readonly string[] {
  const statements = sql
    .split(DRIZZLE_STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new Error("Schema upgrade migration must contain at least one statement.");
  }
  for (const statement of statements) {
    const executable = statement
      .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/g, "")
      .trimStart();
    if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(executable)) {
      throw new Error(
        "Schema upgrade artifacts must not contain transaction-control statements.",
      );
    }
    if (
      /^(?:VACUUM|ATTACH|DETACH|PRAGMA|ALTER\s+SYSTEM|CREATE\s+DATABASE|DROP\s+DATABASE)\b/i
        .test(executable)
      || /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX)\s+CONCURRENTLY\b/i
        .test(executable)
    ) {
      throw new Error(
        "Schema upgrade artifacts must contain only transaction-safe statements.",
      );
    }
  }
  return statements;
}

export function validateSchemaUpgradeArtifacts(
  artifacts: readonly SchemaUpgradeArtifact[],
): readonly SchemaUpgradeArtifact[] {
  if (artifacts.length === 0) {
    throw new Error("No provider-neutral schema upgrade artifacts were found.");
  }
  const ordered = [...artifacts].sort((left, right) => left.version - right.version);
  const names = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const artifact = ordered[index]!;
    const expectedVersion = FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION + index;
    if (artifact.version !== expectedVersion) {
      throw new Error(
        `Schema upgrade artifacts are not contiguous at version ${expectedVersion}.`,
      );
    }
    if (names.has(artifact.name)) {
      throw new Error(`Schema upgrade ${artifact.name} is duplicated.`);
    }
    names.add(artifact.name);
    if (
      artifact.name !== `${String(artifact.version).padStart(4, "0")}_${artifact.name.slice(5)}`
      || !/^\d{4}_[a-z0-9_]+$/.test(artifact.name)
    ) {
      throw new Error(`Schema upgrade ${JSON.stringify(artifact.name)} has an invalid identity.`);
    }
    if (artifact.sqliteStatements.length === 0 || artifact.postgresStatements.length === 0) {
      throw new Error(`Schema upgrade ${artifact.name} is missing provider SQL.`);
    }
    for (const [label, digest] of [
      ["source", artifact.sourceSha256],
      ["Turso", artifact.tursoSha256],
      ["PostgreSQL", artifact.postgresSha256],
    ] as const) {
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new Error(`${artifact.name} has an invalid ${label} SHA-256 digest.`);
      }
    }
  }
  const latest = ordered.at(-1)!;
  if (
    latest.version !== CURRENT_DATABASE_SCHEMA.version
    || latest.name !== CURRENT_DATABASE_SCHEMA.name
  ) {
    throw new Error(
      `Schema upgrade artifacts end at ${latest.version}/${latest.name}; expected `
      + `${CURRENT_DATABASE_SCHEMA.version}/${CURRENT_DATABASE_SCHEMA.name}.`,
    );
  }
  if (ordered.length !== CURRENT_DATABASE_SCHEMA_MIGRATIONS.length) {
    throw new Error(
      "Schema upgrade artifacts do not match the runtime release manifest.",
    );
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const artifact = ordered[index]!;
    const expected = CURRENT_DATABASE_SCHEMA_MIGRATIONS[index]!;
    if (
      artifact.version !== expected.version
      || artifact.name !== expected.name
      || artifact.sourceSha256 !== expected.sourceSha256
    ) {
      throw new Error(
        `Schema upgrade artifact ${artifact.name} differs from the runtime release manifest.`,
      );
    }
  }
  return ordered;
}

export function validateAppliedSchemaMigrations(
  rows: readonly {
    version: unknown;
    name: unknown;
    sourceSha256: unknown;
  }[],
  artifacts: readonly SchemaUpgradeArtifact[],
): DatabaseSchemaState {
  if (rows.length === 0) {
    throw new Error("Database schema migration ledger is empty.");
  }
  const expectedByVersion = new Map(artifacts.map((artifact) => [artifact.version, artifact]));
  const ordered = rows
    .map((row) => requireMigrationIdentity(
      row.version,
      row.name,
      row.sourceSha256,
    ))
    .sort((left, right) => left.version - right.version);
  if (ordered.length > artifacts.length) {
    throw new Error("Database schema migration ledger contains a future row.");
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const expectedVersion = FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION + index;
    const state = ordered[index]!;
    const expected = expectedByVersion.get(expectedVersion);
    if (
      state.version !== expectedVersion
      || !expected
      || state.name !== expected.name
      || state.sourceSha256 !== expected.sourceSha256
    ) {
      throw new Error(
        `Database schema migration ledger diverges at version ${expectedVersion}.`,
      );
    }
  }
  const latest = ordered.at(-1)!;
  return { version: latest.version, name: latest.name };
}

export async function fingerprintSqliteSchemaCatalog(
  rows: readonly SqliteSchemaCatalogRow[],
): Promise<{ objects: number; sha256: string }> {
  const normalized = rows
    .map((row) => ({
      type: typeof row.type === "string" ? row.type : "",
      name: typeof row.name === "string" ? row.name : "",
      tableName: typeof row.tableName === "string" ? row.tableName : "",
      sql: typeof row.sql === "string" ? row.sql : "",
    }))
    .filter((row) => {
      if (!row.type || !row.name || !row.tableName || !row.sql) {
        throw new Error("SQLite schema catalog contains an invalid row.");
      }
      return !isIgnoredSqliteSchemaObject(row.name)
        && !isIgnoredSqliteSchemaObject(row.tableName);
    })
    .sort((left, right) =>
      left.type.localeCompare(right.type) || left.name.localeCompare(right.name),
    );
  const value = normalized
    .map((row) => JSON.stringify([row.type, row.name, row.tableName, row.sql]))
    .join("\n");
  return { objects: normalized.length, sha256: await sha256Hex(value) };
}

export async function assertLegacyTursoSchemaBaseline(
  executor: SqlitePortabilityExecutor,
): Promise<void> {
  const fingerprint = await fingerprintSqlitePortableSchemaObjects(
    await listSqlitePortableSchemaObjects(executor),
  );
  if (
    fingerprint.objects !== DATABASE_SCHEMA_LEGACY_BASELINE.tursoSchemaObjects
    || fingerprint.sha256 !== DATABASE_SCHEMA_LEGACY_BASELINE.tursoSchemaSha256
  ) {
    throw new Error(
      "Turso schema does not match the verified 0049 upgrade baseline.",
    );
  }
}

function quotePostgresLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Execute under the repository-wide schema advisory lock immediately before
 * one PostgreSQL sidecar. A concurrent runner that applied the same migration
 * is distinguished from genuine drift with a stable SQLSTATE.
 */
export function buildPostgresSchemaUpgradeGuard(
  artifact: SchemaUpgradeArtifact,
  previous: DatabaseSchemaState,
  expectedPreviousMigrations: readonly DatabaseSchemaMigration[] = [],
): string {
  const baseline = DATABASE_SCHEMA_LEGACY_BASELINE;
  const currentTable = "public.scalius_schema_migrations";
  const baselineGuard = artifact.version === FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION
    ? [
        `IF to_regclass(${quotePostgresLiteral(currentTable)}) IS NULL THEN`,
        `  IF to_regclass(${quotePostgresLiteral(POSTGRES_MIGRATION_STATE_REGCLASS)}) IS NULL THEN`,
        "    RAISE EXCEPTION 'PostgreSQL schema baseline authority is missing';",
        "  END IF;",
        "  IF NOT EXISTS (",
        `    SELECT 1 FROM ${postgresMigrationControlTable(POSTGRES_MIGRATION_STATE_TABLE)}`,
        `    WHERE phase = 'complete'`,
        `      AND schema_version = ${quotePostgresLiteral(baseline.postgresSchemaBundleVersion)}`,
        `      AND schema_sha256 = ${quotePostgresLiteral(baseline.postgresSchemaSha256)}`,
        "  ) THEN",
        "    RAISE EXCEPTION 'PostgreSQL schema does not match the verified 0049 upgrade baseline';",
        "  END IF;",
        "ELSE",
      ].join("\n")
    : `IF to_regclass(${quotePostgresLiteral(currentTable)}) IS NULL THEN\n`
      + "  RAISE EXCEPTION 'PostgreSQL schema migration ledger is missing';\n"
      + "ELSE";
  return [
    "DO $scalius_schema_upgrade$",
    "DECLARE",
    "  current_version bigint;",
    "  current_name text;",
    "  current_source_sha256 text;",
    "  migration_count bigint;",
    "  current_manifest text;",
    "BEGIN",
    `  IF NOT pg_try_advisory_xact_lock(${POSTGRES_MIGRATION_LOCK_KEY_SQL}) THEN`,
    `    RAISE EXCEPTION USING ERRCODE = '${POSTGRES_SCHEMA_UPGRADE_BUSY_CODE}',`,
    "      MESSAGE = 'Another database migration owns this PostgreSQL target';",
    "  END IF;",
    `  ${baselineGuard.replaceAll("\n", "\n  ")}`,
    "    SELECT version, name, source_sha256",
    "      INTO current_version, current_name, current_source_sha256",
    "    FROM scalius_schema_migrations ORDER BY version DESC LIMIT 1;",
    "    SELECT count(*) INTO migration_count FROM scalius_schema_migrations;",
    "    SELECT string_agg(version::text || ':' || name || ':' || source_sha256, E'\\n' ORDER BY version)",
    "      INTO current_manifest FROM scalius_schema_migrations;",
    `    IF current_version = ${artifact.version}`,
    `       AND current_name = ${quotePostgresLiteral(artifact.name)}`,
    `       AND current_source_sha256 = ${quotePostgresLiteral(artifact.sourceSha256)}`,
    `       AND migration_count = ${artifact.version - FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION + 1} THEN`,
    `      RAISE EXCEPTION USING ERRCODE = '${POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE}',`,
    `        MESSAGE = 'Schema migration ${artifact.name} is already applied';`,
    "    END IF;",
    `    IF current_version IS DISTINCT FROM ${previous.version}`,
    `       OR current_name IS DISTINCT FROM ${quotePostgresLiteral(previous.name)}`,
    `       OR migration_count IS DISTINCT FROM ${expectedPreviousMigrations.length}`,
    `       OR current_manifest IS DISTINCT FROM ${quotePostgresLiteral(
      expectedPreviousMigrations
        .map((migration) =>
          `${migration.version}:${migration.name}:${migration.sourceSha256}`,
        )
        .join("\n"),
    )} THEN`,
    `      RAISE EXCEPTION 'PostgreSQL schema must be ${previous.version}/${previous.name} before ${artifact.name}';`,
    "    END IF;",
    "  END IF;",
    "END",
    "$scalius_schema_upgrade$;",
  ].join("\n");
}

export function previousSchemaIdentity(
  artifacts: readonly SchemaUpgradeArtifact[],
  artifact: SchemaUpgradeArtifact,
): DatabaseSchemaState {
  if (artifact.version === FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION) {
    return DATABASE_SCHEMA_LEGACY_BASELINE;
  }
  const previous = artifacts.find((candidate) =>
    candidate.version === artifact.version - 1,
  );
  if (!previous) {
    throw new Error(`Schema upgrade ${artifact.name} has no previous artifact.`);
  }
  return { version: previous.version, name: previous.name };
}

export function previousSchemaMigrations(
  artifacts: readonly SchemaUpgradeArtifact[],
  artifact: SchemaUpgradeArtifact,
): readonly DatabaseSchemaMigration[] {
  return artifacts
    .filter((candidate) => candidate.version < artifact.version)
    .map((candidate) => ({
      version: candidate.version,
      name: candidate.name,
      sourceSha256: candidate.sourceSha256,
    }));
}
