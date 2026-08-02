import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  connect,
} from "@tursodatabase/serverless";

import { connectNeonPostgres, type PostgresHttpConnection } from "../src/postgres-adapter";
import {
  CURRENT_DATABASE_SCHEMA,
  DATABASE_SCHEMA_CONTRACT_VERSION,
  DATABASE_SCHEMA_LEGACY_BASELINE,
  type DatabaseSchemaState,
} from "../src/schema-contract";
import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import {
  POSTGRES_MIGRATION_STATE_REGCLASS,
  POSTGRES_MIGRATION_STATE_TABLE,
  postgresMigrationControlTable,
} from "../src/postgres-migration-control";
import {
  assertLegacyTursoSchemaBaseline,
  buildPostgresSchemaUpgradeGuard,
  FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION,
  POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE,
  fingerprintSqliteSchemaCatalog,
  previousSchemaMigrations,
  previousSchemaIdentity,
  splitSchemaMigrationStatements,
  validateAppliedSchemaMigrations,
  validateSchemaUpgradeArtifacts,
  type SchemaUpgradeArtifact,
  type SqliteSchemaCatalogRow,
} from "../src/schema-upgrade";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(scriptDirectory, "../migrations");
const postgresMigrationDirectory = join(migrationDirectory, "postgres");
const SQLITE_SCHEMA_TABLE = "scalius_schema_migrations";

type ExternalSchemaProvider = "turso" | "postgres";

export interface SchemaUpgradeReceipt {
  contractVersion: typeof DATABASE_SCHEMA_CONTRACT_VERSION;
  provider: ExternalSchemaProvider;
  targetHost: string;
  before: DatabaseSchemaState;
  after: DatabaseSchemaState;
  applied: readonly {
    version: number;
    name: string;
    sha256: string;
  }[];
  dryRun: boolean;
  freezeProofSha256: string | null;
}

interface TursoSchemaExecutor {
  all(sql: string, ...bindParameters: unknown[]): Promise<unknown[]>;
}

interface TursoSchemaTransaction extends TursoSchemaExecutor {
  batch(statements: string[]): Promise<unknown>;
}

export interface TursoSchemaConnection extends TursoSchemaExecutor {
  transactionAsync<T>(
    callback: (transaction: TursoSchemaTransaction) => Promise<T>,
  ): { immediate(): Promise<T> };
  close(): Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function migrationIdentity(filename: string): DatabaseSchemaState {
  const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(filename);
  if (!match) throw new Error(`Invalid schema migration filename ${JSON.stringify(filename)}.`);
  return { version: Number(match[1]), name: filename.slice(0, -4) };
}

function schemaMigrationPayload(statements: readonly string[]): string {
  return `${statements.map((statement) => statement.trim()).join(
    "\n--> statement-breakpoint\n",
  )}\n`;
}

function requireLedgerInsert(
  statements: readonly string[],
  identity: DatabaseSchemaState,
  sourceSha256: string,
): void {
  const ledgerStatements = statements.filter((statement) =>
    /^INSERT\s+INTO\s+[`"]?scalius_schema_migrations[`"]?\b/i.test(
      statement.trim(),
    ),
  );
  if (ledgerStatements.length !== 1 || ledgerStatements[0] !== statements.at(-1)) {
    throw new Error(
      `Schema migration ${identity.name} must end with exactly one ledger insert.`,
    );
  }
  const sql = ledgerStatements[0]!;
  const normalized = sql
    .replace(/[`"]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const expected = "INSERT INTO scalius_schema_migrations "
    + `(version, name, source_sha256) VALUES (${identity.version}, `
    + `'${identity.name}', '${sourceSha256}')`;
  if (normalized.replace(/;$/, "") !== expected) {
    throw new Error(
      `Schema migration ${identity.name} must record its exact identity and source digest.`,
    );
  }
}

export async function loadSchemaUpgradeArtifacts(): Promise<readonly SchemaUpgradeArtifact[]> {
  const filenames = (await readdir(migrationDirectory))
    .filter((filename) => /^\d{4}_[a-z0-9_]+\.sql$/.test(filename))
    .filter((filename) => Number(filename.slice(0, 4)) >= FIRST_PROVIDER_NEUTRAL_SCHEMA_VERSION)
    .sort((left, right) => left.localeCompare(right));
  const artifacts: SchemaUpgradeArtifact[] = [];
  for (const filename of filenames) {
    const identity = migrationIdentity(filename);
    const [sourceSql, postgresSql] = await Promise.all([
      readFile(join(migrationDirectory, filename), "utf8"),
      readFile(join(postgresMigrationDirectory, filename), "utf8").catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`PostgreSQL sidecar is missing for ${identity.name}.`);
        }
        throw error;
      }),
    ]);
    const tursoSql = compileSqliteMigrationForProvider(sourceSql, "turso");
    const sourceStatements = splitSchemaMigrationStatements(sourceSql);
    const postgresStatements = splitSchemaMigrationStatements(postgresSql);
    const sourceSha256 = sha256(schemaMigrationPayload(sourceStatements.slice(0, -1)));
    requireLedgerInsert(sourceStatements, identity, sourceSha256);
    requireLedgerInsert(postgresStatements, identity, sourceSha256);
    artifacts.push({
      ...identity,
      sqliteStatements: splitSchemaMigrationStatements(tursoSql),
      postgresStatements,
      sourceSha256,
      tursoSha256: sha256(tursoSql),
      postgresSha256: sha256(postgresSql),
    });
  }
  return validateSchemaUpgradeArtifacts(artifacts);
}

function rowValue(row: unknown, key: string): unknown {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  return record[key] ?? record[key.toLowerCase()];
}

function tursoPortabilityExecutor(executor: TursoSchemaExecutor) {
  return {
    query: (sql: string, params: readonly unknown[] = []) =>
      executor.all(sql, ...params),
  };
}

async function readTursoRawSchemaFence(
  executor: TursoSchemaExecutor,
): Promise<{ objects: number; sha256: string }> {
  const rows = await executor.all(`
    SELECT type, name, tbl_name AS tableName, sql
    FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `);
  return fingerprintSqliteSchemaCatalog(rows.map((row) => ({
    type: rowValue(row, "type"),
    name: rowValue(row, "name"),
    tableName: rowValue(row, "tableName") ?? rowValue(row, "tbl_name"),
    sql: rowValue(row, "sql"),
  } satisfies SqliteSchemaCatalogRow)));
}

async function readTursoSchemaState(
  executor: TursoSchemaExecutor,
  artifacts: readonly SchemaUpgradeArtifact[],
  expectedLegacyFence?: { objects: number; sha256: string },
): Promise<DatabaseSchemaState> {
  const table = await executor.all(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
    SQLITE_SCHEMA_TABLE,
  );
  if (table.length === 0) {
    if (expectedLegacyFence) {
      const actualFence = await readTursoRawSchemaFence(executor);
      if (
        actualFence.objects !== expectedLegacyFence.objects
        || actualFence.sha256 !== expectedLegacyFence.sha256
      ) {
        throw new Error("Turso schema changed before the upgrade lock was acquired.");
      }
    } else {
      await assertLegacyTursoSchemaBaseline(tursoPortabilityExecutor(executor));
    }
    return DATABASE_SCHEMA_LEGACY_BASELINE;
  }
  const rows = await executor.all(
    `SELECT version, name, source_sha256 AS sourceSha256
     FROM ${SQLITE_SCHEMA_TABLE} ORDER BY version`,
  );
  return validateAppliedSchemaMigrations(rows.map((row) => ({
    version: rowValue(row, "version"),
    name: rowValue(row, "name"),
    sourceSha256: rowValue(row, "sourceSha256") ?? rowValue(row, "source_sha256"),
  })), artifacts);
}

function nextArtifact(
  state: DatabaseSchemaState,
  artifacts: readonly SchemaUpgradeArtifact[],
): SchemaUpgradeArtifact | null {
  if (
    state.version === CURRENT_DATABASE_SCHEMA.version
    && state.name === CURRENT_DATABASE_SCHEMA.name
  ) return null;
  const next = artifacts.find((artifact) => artifact.version === state.version + 1);
  if (!next) {
    throw new Error(
      `No schema upgrade continues from ${state.version}/${state.name}.`,
    );
  }
  const previous = previousSchemaIdentity(artifacts, next);
  if (state.version !== previous.version || state.name !== previous.name) {
    throw new Error(
      `Schema upgrade ${next.name} requires ${previous.version}/${previous.name}.`,
    );
  }
  return next;
}

export async function inspectTursoSchemaUpgrade(
  connection: TursoSchemaConnection,
  artifacts: readonly SchemaUpgradeArtifact[],
): Promise<DatabaseSchemaState> {
  return readTursoSchemaState(connection, artifacts);
}

export async function applyTursoSchemaUpgrades(
  connection: TursoSchemaConnection,
  artifacts: readonly SchemaUpgradeArtifact[],
): Promise<{ before: DatabaseSchemaState; after: DatabaseSchemaState; applied: SchemaUpgradeArtifact[] }> {
  const before = await readTursoSchemaState(connection, artifacts);
  const legacyFence = before.version === DATABASE_SCHEMA_LEGACY_BASELINE.version
    ? await readTursoRawSchemaFence(connection)
    : undefined;
  const applied: SchemaUpgradeArtifact[] = [];
  while (true) {
    const result = await connection.transactionAsync(async (transaction) => {
      const state = await readTursoSchemaState(transaction, artifacts, legacyFence);
      const artifact = nextArtifact(state, artifacts);
      if (!artifact) return { state, artifact: null };
      await transaction.batch([...artifact.sqliteStatements]);
      const updated = await readTursoSchemaState(transaction, artifacts);
      if (updated.version !== artifact.version || updated.name !== artifact.name) {
        throw new Error(`Turso schema upgrade ${artifact.name} did not commit its ledger row.`);
      }
      return { state: updated, artifact };
    }).immediate();
    if (!result.artifact) {
      return { before, after: result.state, applied };
    }
    if (!applied.some((artifact) => artifact.version === result.artifact!.version)) {
      applied.push(result.artifact);
    }
  }
}

function postgresScalar(result: Awaited<ReturnType<PostgresHttpConnection["query"]>>): unknown {
  return result.rows[0]?.[0];
}

async function readPostgresSchemaState(
  connection: PostgresHttpConnection,
  artifacts: readonly SchemaUpgradeArtifact[],
): Promise<DatabaseSchemaState> {
  const table = await connection.query(
    "SELECT to_regclass('public.scalius_schema_migrations')::text",
    [],
  );
  if (!postgresScalar(table)) {
    const baselineTable = await connection.query(
      "SELECT to_regclass($1)::text",
      [POSTGRES_MIGRATION_STATE_REGCLASS],
    );
    if (!postgresScalar(baselineTable)) {
      throw new Error("PostgreSQL schema baseline authority is missing.");
    }
    const baseline = await connection.query(
      `SELECT schema_version, schema_sha256, phase
       FROM ${postgresMigrationControlTable(POSTGRES_MIGRATION_STATE_TABLE)}
       ORDER BY updated_at DESC LIMIT 1`,
      [],
    );
    const row = baseline.rows[0];
    if (
      !row
      || row[0] !== DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion
      || row[1] !== DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256
      || row[2] !== "complete"
    ) {
      throw new Error(
        "PostgreSQL schema does not match the verified 0049 upgrade baseline.",
      );
    }
    return DATABASE_SCHEMA_LEGACY_BASELINE;
  }
  const result = await connection.query(
    "SELECT version, name, source_sha256 FROM scalius_schema_migrations ORDER BY version",
    [],
  );
  return validateAppliedSchemaMigrations(result.rows.map((row) => ({
    version: row[0],
    name: row[1],
    sourceSha256: row[2],
  })), artifacts);
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return postgresErrorCode(candidate.cause);
}

export async function inspectPostgresSchemaUpgrade(
  connection: PostgresHttpConnection,
  artifacts: readonly SchemaUpgradeArtifact[],
): Promise<DatabaseSchemaState> {
  return readPostgresSchemaState(connection, artifacts);
}

export async function applyPostgresSchemaUpgrades(
  connection: PostgresHttpConnection,
  artifacts: readonly SchemaUpgradeArtifact[],
): Promise<{ before: DatabaseSchemaState; after: DatabaseSchemaState; applied: SchemaUpgradeArtifact[] }> {
  const before = await readPostgresSchemaState(connection, artifacts);
  const applied: SchemaUpgradeArtifact[] = [];
  while (true) {
    const state = await readPostgresSchemaState(connection, artifacts);
    const artifact = nextArtifact(state, artifacts);
    if (!artifact) return { before, after: state, applied };
    const previous = previousSchemaIdentity(artifacts, artifact);
    const queries = [
      connection.query(buildPostgresSchemaUpgradeGuard(
        artifact,
        previous,
        previousSchemaMigrations(artifacts, artifact),
      ), []),
      ...artifact.postgresStatements.map((statement) => connection.query(statement, [])),
    ];
    try {
      const results = await connection.transaction(queries, {
        arrayMode: true,
        fullResults: true,
        isolationLevel: "Serializable",
        readOnly: false,
      });
      if (results.length !== queries.length) {
        throw new Error(`PostgreSQL schema upgrade ${artifact.name} returned incomplete results.`);
      }
      applied.push(artifact);
    } catch (error) {
      if (postgresErrorCode(error) !== POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE) {
        throw error;
      }
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseArguments(argv: readonly string[]): {
  provider: ExternalSchemaProvider;
  acknowledgedTargetHost: string;
  dryRun: boolean;
  requireCurrent: boolean;
  freezeProofSha256: string | null;
} {
  let provider: ExternalSchemaProvider | undefined;
  let acknowledgedTargetHost: string | undefined;
  let dryRun = false;
  let requireCurrent = false;
  let freezeProofSha256: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--provider") {
      const value = argv[++index];
      if (value === "turso" || value === "postgres") provider = value;
      else throw new Error("--provider must be turso or postgres.");
    } else if (argument === "--acknowledge-target-host") {
      acknowledgedTargetHost = argv[++index];
    } else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--require-current") requireCurrent = true;
    else if (argument === "--freeze-proof-sha256") {
      freezeProofSha256 = argv[++index] ?? null;
    }
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!provider) throw new Error("--provider is required.");
  if (!acknowledgedTargetHost?.trim()) {
    throw new Error("--acknowledge-target-host is required.");
  }
  if (requireCurrent && !dryRun) {
    throw new Error("--require-current is valid only with --dry-run.");
  }
  if (!dryRun && !/^[a-f0-9]{64}$/.test(freezeProofSha256 ?? "")) {
    throw new Error(
      "Schema mutation requires --freeze-proof-sha256 from the control plane's verified write freeze.",
    );
  }
  if (dryRun && freezeProofSha256 !== null) {
    throw new Error("--freeze-proof-sha256 is not accepted for a read-only dry run.");
  }
  return {
    provider,
    acknowledgedTargetHost: acknowledgedTargetHost.trim(),
    dryRun,
    requireCurrent,
    freezeProofSha256,
  };
}

function requireAcknowledgedTarget(url: string, acknowledgedHost: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Database connection URL is invalid.");
  }
  if (!parsed.hostname || parsed.hostname !== acknowledgedHost) {
    throw new Error("Database target host does not match --acknowledge-target-host.");
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const artifacts = await loadSchemaUpgradeArtifacts();
  let result: {
    before: DatabaseSchemaState;
    after: DatabaseSchemaState;
    applied: readonly SchemaUpgradeArtifact[];
  };

  if (options.provider === "turso") {
    const url = optionalString(process.env.TURSO_DATABASE_URL);
    const authToken = optionalString(process.env.TURSO_AUTH_TOKEN);
    if (!url || !authToken) {
      throw new Error("TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.");
    }
    const parsed = requireAcknowledgedTarget(url, options.acknowledgedTargetHost);
    if (!["turso:", "libsql:", "https:"].includes(parsed.protocol)) {
      throw new Error("Turso upgrade URL must use turso://, libsql://, or https://.");
    }
    const connection = connect({ url, authToken }) as unknown as TursoSchemaConnection;
    try {
      const before = await inspectTursoSchemaUpgrade(connection, artifacts);
      result = options.dryRun
        ? { before, after: before, applied: [] }
        : await applyTursoSchemaUpgrades(connection, artifacts);
    } finally {
      await connection.close();
    }
  } else {
    const databaseUrl = optionalString(process.env.POSTGRES_DATABASE_URL);
    if (!databaseUrl) throw new Error("POSTGRES_DATABASE_URL is required.");
    const parsed = requireAcknowledgedTarget(databaseUrl, options.acknowledgedTargetHost);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("PostgreSQL upgrade URL must use postgres:// or postgresql://.");
    }
    const connection = connectNeonPostgres(databaseUrl);
    const before = await inspectPostgresSchemaUpgrade(connection, artifacts);
    result = options.dryRun
      ? { before, after: before, applied: [] }
      : await applyPostgresSchemaUpgrades(connection, artifacts);
  }

  if (
    options.requireCurrent
    && (
      result.after.version !== CURRENT_DATABASE_SCHEMA.version
      || result.after.name !== CURRENT_DATABASE_SCHEMA.name
    )
  ) {
    throw new Error(
      `Database schema ${result.after.version}/${result.after.name} is not current; expected `
      + `${CURRENT_DATABASE_SCHEMA.version}/${CURRENT_DATABASE_SCHEMA.name}.`,
    );
  }

  const providerDigest = (artifact: SchemaUpgradeArtifact) =>
    options.provider === "turso" ? artifact.tursoSha256 : artifact.postgresSha256;
  const receipt: SchemaUpgradeReceipt = {
    contractVersion: DATABASE_SCHEMA_CONTRACT_VERSION,
    provider: options.provider,
    targetHost: options.acknowledgedTargetHost,
    before: result.before,
    after: result.after,
    applied: result.applied.map((artifact) => ({
      version: artifact.version,
      name: artifact.name,
      sha256: providerDigest(artifact),
    })),
    dryRun: options.dryRun,
    freezeProofSha256: options.freezeProofSha256,
  };
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
