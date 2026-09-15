/**
 * Machine-readable D1 migration contract for deployments that apply
 * `migrations/*.sql` through the Cloudflare D1 HTTP API instead of
 * `wrangler d1 migrations apply`.
 *
 * The plan reproduces exactly what Wrangler would execute for every canonical
 * migration file, including the `d1_migrations` ledger row Wrangler appends
 * after each file, so a later `wrangler d1 migrations apply` reports nothing
 * left to apply. It also surfaces the provider-neutral release ledger
 * (`scalius_schema_migrations`) that every migration from 0050 onward writes
 * itself, so automation can verify the release identity independently.
 *
 * This module is pure: no filesystem access, no provider clients. Callers pass
 * file names and contents; `scripts/print-migration-plan.ts` is the CLI wrapper.
 */

import { DRIZZLE_STATEMENT_BREAKPOINT } from "./migration-artifacts";
import {
  CURRENT_DATABASE_SCHEMA,
  DATABASE_SCHEMA_LEGACY_BASELINE,
  type DatabaseSchemaMigration,
  type DatabaseSchemaState,
} from "./schema-contract";

export const D1_MIGRATION_PLAN_CONTRACT =
  "scalius-d1-migration-plan/v1" as const;

/** Wrangler's default `migrations_table` for D1 (`DEFAULT_MIGRATION_TABLE`). */
export const D1_MIGRATIONS_LEDGER_TABLE = "d1_migrations" as const;

/**
 * Verbatim output of Wrangler's `getCreateMigrationsTableQuery` for the default
 * table name, including its two-tab column indentation. Wrangler runs this
 * before listing applied migrations on every `apply`/`list`.
 */
export const D1_MIGRATIONS_LEDGER_DDL =
  `CREATE TABLE IF NOT EXISTS "${D1_MIGRATIONS_LEDGER_TABLE}"(\n`
  + "\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n"
  + "\t\tname       TEXT UNIQUE,\n"
  + "\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n"
  + ");";

/** Verbatim output of Wrangler's `getListAppliedMigrationsQuery`. */
export const D1_MIGRATIONS_LEDGER_LIST_SQL =
  `SELECT *\n\t\tFROM "${D1_MIGRATIONS_LEDGER_TABLE}"\n\t\tORDER BY id`;

/** Provider-neutral release ledger written by the migration SQL itself. */
export const SCALIUS_SCHEMA_LEDGER_TABLE = "scalius_schema_migrations" as const;

/** First migration that records itself in `scalius_schema_migrations`. */
export const FIRST_RELEASE_LEDGER_VERSION =
  DATABASE_SCHEMA_LEGACY_BASELINE.version + 1;

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_LEDGER_INSERT_PATTERN =
  /^INSERT\s+INTO\s+[`"]?scalius_schema_migrations[`"]?\b/i;

export interface D1MigrationFile {
  /** File name relative to `migrations/`, e.g. `0061_regular_hex.sql`. */
  name: string;
  /** Raw UTF-8 file content, byte-identical to what Wrangler would execute. */
  sql: string;
}

export interface D1PlannedMigration {
  /** Numeric file prefix, e.g. 61. */
  version: number;
  /** File name without `.sql`, e.g. `0061_regular_hex`. */
  name: string;
  /** File name with `.sql`; this is the `d1_migrations.name` value. */
  file: string;
  /** SHA-256 hex of the raw file content. */
  fileSha256: string;
  /** Statements in execution order, split on the Drizzle breakpoint. */
  statements: readonly string[];
  /** Exact `d1_migrations` insert Wrangler appends after the file's statements. */
  ledgerInsert: string;
  /**
   * Row the file inserts into `scalius_schema_migrations`, or `null` before
   * the release ledger existed (versions below 0050). `sourceSha256` is the
   * digest of the file's statements without that final insert.
   */
  releaseLedger: DatabaseSchemaMigration | null;
}

export interface D1MigrationPlan {
  contract: typeof D1_MIGRATION_PLAN_CONTRACT;
  ledgerTable: typeof D1_MIGRATIONS_LEDGER_TABLE;
  ledgerDdl: typeof D1_MIGRATIONS_LEDGER_DDL;
  ledgerListSql: typeof D1_MIGRATIONS_LEDGER_LIST_SQL;
  releaseLedgerTable: typeof SCALIUS_SCHEMA_LEDGER_TABLE;
  expectedSchema: DatabaseSchemaState;
  migrations: readonly D1PlannedMigration[];
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Mirrors Wrangler's `buildMigrationQuery` ledger suffix byte for byte. */
export function buildD1LedgerInsert(file: string): string {
  return `INSERT INTO "${D1_MIGRATIONS_LEDGER_TABLE}" (name)\nvalues (${quoteSqlLiteral(file)});`;
}

/**
 * Same split as `splitSchemaMigrationStatements` in `./schema-upgrade`: cut on
 * the Drizzle breakpoint, trim, drop empties. Statements are never re-split on
 * `;` because trigger bodies contain inner semicolons.
 */
export function splitD1MigrationStatements(sql: string): readonly string[] {
  const statements = sql
    .split(DRIZZLE_STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length === 0) {
    throw new Error("D1 migration must contain at least one statement.");
  }
  return statements;
}

/** Same payload as `schemaMigrationPayload` in `scripts/upgrade-provider-schema.ts`. */
export function buildReleaseLedgerPayload(statements: readonly string[]): string {
  return `${statements.map((statement) => statement.trim()).join(
    `\n${DRIZZLE_STATEMENT_BREAKPOINT}\n`,
  )}\n`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function parseMigrationIdentity(file: string): DatabaseSchemaState {
  const match = MIGRATION_FILE_PATTERN.exec(file);
  if (!match) {
    throw new Error(`Invalid D1 migration file name ${JSON.stringify(file)}.`);
  }
  return { version: Number(match[1]), name: file.slice(0, -4) };
}

/**
 * Mirrors `requireLedgerInsert` in `scripts/upgrade-provider-schema.ts`: the
 * final statement must be the one exact release-ledger row for this file.
 */
async function requireReleaseLedgerInsert(
  identity: DatabaseSchemaState,
  statements: readonly string[],
): Promise<DatabaseSchemaMigration> {
  const ledgerStatements = statements.filter((statement) =>
    RELEASE_LEDGER_INSERT_PATTERN.test(statement),
  );
  if (ledgerStatements.length !== 1 || ledgerStatements[0] !== statements.at(-1)) {
    throw new Error(
      `D1 migration ${identity.name} must end with exactly one `
      + `${SCALIUS_SCHEMA_LEDGER_TABLE} insert.`,
    );
  }
  const sourceSha256 = await sha256Hex(
    buildReleaseLedgerPayload(statements.slice(0, -1)),
  );
  const normalized = ledgerStatements[0]!
    .replace(/[`"]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
  const expected = `INSERT INTO ${SCALIUS_SCHEMA_LEDGER_TABLE} `
    + `(version, name, source_sha256) VALUES (${identity.version}, `
    + `'${identity.name}', '${sourceSha256}')`;
  if (normalized !== expected) {
    throw new Error(
      `D1 migration ${identity.name} must record its exact identity and source digest.`,
    );
  }
  return { ...identity, sourceSha256 };
}

async function planMigration(file: D1MigrationFile): Promise<D1PlannedMigration> {
  const identity = parseMigrationIdentity(file.name);
  const statements = splitD1MigrationStatements(file.sql);
  const releaseLedger = identity.version >= FIRST_RELEASE_LEDGER_VERSION
    ? await requireReleaseLedgerInsert(identity, statements)
    : null;
  return {
    ...identity,
    file: file.name,
    fileSha256: await sha256Hex(file.sql),
    statements,
    ledgerInsert: buildD1LedgerInsert(file.name),
    releaseLedger,
  };
}

/**
 * Build the ordered plan for a canonical migration chain. The chain must be
 * contiguous from 0000 with no duplicate prefix; input order is irrelevant.
 */
export async function buildD1MigrationPlan(
  files: readonly D1MigrationFile[],
): Promise<D1MigrationPlan> {
  if (files.length === 0) {
    throw new Error("D1 migration plan requires at least one migration file.");
  }
  const migrations = await Promise.all(files.map(planMigration));
  migrations.sort((left, right) => left.version - right.version);
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!;
    if (migration.version !== index) {
      throw new Error(
        `D1 migration chain is not contiguous at ${String(index).padStart(4, "0")} `
        + `(found ${migration.file}).`,
      );
    }
  }
  return {
    contract: D1_MIGRATION_PLAN_CONTRACT,
    ledgerTable: D1_MIGRATIONS_LEDGER_TABLE,
    ledgerDdl: D1_MIGRATIONS_LEDGER_DDL,
    ledgerListSql: D1_MIGRATIONS_LEDGER_LIST_SQL,
    releaseLedgerTable: SCALIUS_SCHEMA_LEDGER_TABLE,
    expectedSchema: CURRENT_DATABASE_SCHEMA,
    migrations,
  };
}

/**
 * Fail closed when the plan does not end at the release the runtime expects
 * (`CURRENT_DATABASE_SCHEMA`), or when a release-ledger digest is malformed.
 */
export function assertD1MigrationPlanCurrent(plan: D1MigrationPlan): void {
  const latest = plan.migrations.at(-1);
  if (
    !latest
    || latest.version !== plan.expectedSchema.version
    || latest.name !== plan.expectedSchema.name
  ) {
    throw new Error(
      `D1 migration plan ends at ${latest ? latest.name : "nothing"}; expected `
      + `${plan.expectedSchema.name}.`,
    );
  }
  for (const migration of plan.migrations) {
    if (
      migration.releaseLedger
      && !SHA256_HEX_PATTERN.test(migration.releaseLedger.sourceSha256)
    ) {
      throw new Error(`${migration.name} has an invalid release-ledger digest.`);
    }
  }
}

/**
 * Compute the migrations still to run from the `d1_migrations.name` values
 * ordered by `id`. The applied names must be an exact ordered prefix of the
 * plan: an unknown name or a gap means the ledger belongs to a foreign or
 * diverged chain and nothing may be applied on top of it.
 */
export function listPendingD1Migrations(
  plan: D1MigrationPlan,
  appliedNames: readonly string[],
): readonly D1PlannedMigration[] {
  const known = new Set(plan.migrations.map((migration) => migration.file));
  for (const applied of appliedNames) {
    if (!known.has(applied)) {
      throw new Error(
        `${D1_MIGRATIONS_LEDGER_TABLE} contains unknown migration ${JSON.stringify(applied)}.`,
      );
    }
  }
  if (appliedNames.length > plan.migrations.length) {
    throw new Error(`${D1_MIGRATIONS_LEDGER_TABLE} contains more rows than the plan.`);
  }
  for (let index = 0; index < appliedNames.length; index += 1) {
    const expected = plan.migrations[index]!.file;
    if (appliedNames[index] !== expected) {
      throw new Error(
        `${D1_MIGRATIONS_LEDGER_TABLE} diverges at row ${index + 1}: expected `
        + `${expected}, found ${JSON.stringify(appliedNames[index])}.`,
      );
    }
  }
  return plan.migrations.slice(appliedNames.length);
}
