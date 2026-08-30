import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import {
  CURRENT_DATABASE_SCHEMA,
  DATABASE_SCHEMA_LEGACY_BASELINE,
} from "../src/schema-contract";
import {
  buildPostgresSchemaUpgradeGuard,
  POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE,
  POSTGRES_SCHEMA_UPGRADE_BUSY_CODE,
  splitSchemaMigrationStatements,
  validateAppliedSchemaMigrations,
} from "../src/schema-upgrade";
import {
  compileCanonicalPostgresSchema,
  compileSqliteDdlForPostgres,
} from "../scripts/postgres-schema";
import {
  POSTGRES_MIGRATION_STATE_REGCLASS,
  POSTGRES_MIGRATION_STATE_TABLE,
  postgresMigrationControlTable,
} from "../src/postgres-migration-control";
import {
  buildPostgresMigrationControlSql,
  SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
} from "../scripts/migrate-sqlite-to-postgres";
import type { PostgresFullResult, PostgresHttpConnection } from "../src/postgres-adapter";
import {
  applyPostgresSchemaUpgrades,
  applyTursoSchemaUpgrades,
  inspectTursoSchemaUpgrade,
  loadSchemaUpgradeArtifacts,
  type TursoSchemaConnection,
} from "../scripts/upgrade-provider-schema";

const migrationsDirectory = resolve(import.meta.dirname, "../migrations");

function createLegacyTursoDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const filename of readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0050_")
    .sort()) {
    database.exec(compileSqliteMigrationForProvider(
      readFileSync(join(migrationsDirectory, filename), "utf8"),
      "turso",
    ));
  }
  return database;
}

function createLocalTursoConnection(database: DatabaseSync): TursoSchemaConnection {
  const all = async (sql: string, ...params: unknown[]) =>
    database.prepare(sql).all(...params as SQLInputValue[]);
  return {
    all,
    transactionAsync<T>(callback: (transaction: {
      all: typeof all;
      batch(statements: string[]): Promise<unknown>;
    }) => Promise<T>) {
      return {
        async immediate() {
          database.exec("BEGIN IMMEDIATE");
          try {
            const result = await callback({
              all,
              async batch(statements) {
                for (const statement of statements) database.exec(statement);
                return [];
              },
            });
            database.exec("COMMIT");
            return result;
          } catch (error) {
            database.exec("ROLLBACK");
            throw error;
          }
        },
      };
    },
    async close() {},
  };
}

function postgresResult(rows: unknown[][]): PostgresFullResult {
  return { rows, fields: [] };
}

function quoteSqliteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

describe("provider-neutral schema upgrades", () => {
  it("loads a contiguous migration chain with exact Turso and PostgreSQL sidecars", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    expect(artifacts.map((artifact) => ({
      version: artifact.version,
      name: artifact.name,
      sqliteStatements: artifact.sqliteStatements.length,
      postgresStatements: artifact.postgresStatements.length,
    }))).toEqual([
      {
        version: 50,
        name: "0050_schema_release_contract",
        sqliteStatements: 3,
        postgresStatements: 3,
      },
      {
        version: 51,
        name: "0051_orders_checkout_write_path",
        sqliteStatements: 10,
        postgresStatements: 10,
      },
      {
        version: 52,
        name: "0052_remove_storefront_cache_queue",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 53,
        name: "0053_checkout_language_authority",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 54,
        name: "0054_cache_invalidation_delivery",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 55,
        name: "0055_cache_invalidation_postgres_bigint",
        sqliteStatements: 2,
        postgresStatements: 2,
      },
      {
        version: 56,
        name: "0056_agent_access",
        sqliteStatements: 46,
        postgresStatements: 46,
      },
      {
        version: 57,
        name: "0057_agent_browser_handoffs",
        sqliteStatements: 5,
        postgresStatements: 5,
      },
      {
        version: 58,
        name: "0058_order_shipping_method_snapshot",
        sqliteStatements: 6,
        postgresStatements: 6,
      },
    ]);
  });

  it("keeps the PostgreSQL sidecar DDL identical to the fresh-schema compiler", () => {
    const source = splitSchemaMigrationStatements(readFileSync(
      join(migrationsDirectory, "0050_schema_release_contract.sql"),
      "utf8",
    ));
    const postgres = splitSchemaMigrationStatements(readFileSync(
      join(migrationsDirectory, "postgres/0050_schema_release_contract.sql"),
      "utf8",
    ));

    expect(postgres.slice(0, -1).map((statement) => statement.trim())).toEqual(
      source.slice(0, -1).map((statement) =>
        `${compileSqliteDdlForPostgres(statement).replace(/;\s*$/, "")};`,
      ),
    );
  });

  it("compiles SQLite substring guards into native PostgreSQL expressions", () => {
    expect(compileSqliteDdlForPostgres(
      `CHECK(instr("artifact"."filename", '/') = 0 AND instr("artifact"."filename", char(92)) = 0)`,
    )).toBe(
      `CHECK(position('/' in "artifact"."filename") = 0 AND position(chr(92) in "artifact"."filename") = 0)`,
    );
    expect(compileSqliteDdlForPostgres(
      `CHECK(instr(coalesce("item"."query", ''), '#') = 0)`,
    )).toBe(
      `CHECK(position('#' in coalesce("item"."query", '')) = 0)`,
    );
  });

  it("converges upgraded PostgreSQL cache counters with the fresh bigint schema", async () => {
    const postgres = splitSchemaMigrationStatements(readFileSync(
      join(migrationsDirectory, "postgres/0055_cache_invalidation_postgres_bigint.sql"),
      "utf8",
    ));
    expect(postgres[0]).toContain('ALTER COLUMN "requested_generation" TYPE bigint');
    expect(postgres[0]).toContain('ALTER COLUMN "applied_generation" TYPE bigint');
    expect(postgres[0]).toContain('ALTER COLUMN "attempt_count" TYPE bigint');

    const freshSchema = await compileCanonicalPostgresSchema();
    const cacheTable = freshSchema.preDataSql.slice(
      freshSchema.preDataSql.indexOf('CREATE TABLE "cache_invalidation_state"'),
      freshSchema.preDataSql.indexOf('CREATE TABLE "categories"'),
    );
    expect(cacheTable).toContain('"requested_generation" bigint');
    expect(cacheTable).toContain('"applied_generation" bigint');
    expect(cacheTable).toContain('"attempt_count" bigint');
  });

  it.each([
    "BEGIN;",
    "VACUUM;",
    "PRAGMA foreign_keys = OFF;",
    "CREATE INDEX CONCURRENTLY example_idx ON example (id);",
  ])("rejects transaction-unsafe sidecar SQL: %s", (sql) => {
    expect(() => splitSchemaMigrationStatements(sql)).toThrow(/transaction/i);
  });

  it("upgrades the exact Turso 0049 baseline atomically and is idempotent", async () => {
    const database = createLegacyTursoDatabase();
    const connection = createLocalTursoConnection(database);
    const artifacts = await loadSchemaUpgradeArtifacts();
    try {
      expect(await inspectTursoSchemaUpgrade(connection, artifacts))
        .toMatchObject(DATABASE_SCHEMA_LEGACY_BASELINE);

      const first = await applyTursoSchemaUpgrades(connection, artifacts);
      expect(first.before).toMatchObject(DATABASE_SCHEMA_LEGACY_BASELINE);
      expect(first.after).toEqual(CURRENT_DATABASE_SCHEMA);
      expect(first.applied.map((artifact) => artifact.name))
        .toEqual(artifacts.map((artifact) => artifact.name));
      expect(database.prepare(
        "SELECT version, name, source_sha256 AS sourceSha256 FROM scalius_schema_migrations ORDER BY version",
      ).all()).toEqual(artifacts.map((artifact) => ({
        version: artifact.version,
        name: artifact.name,
        sourceSha256: artifact.sourceSha256,
      })));

      const replay = await applyTursoSchemaUpgrades(connection, artifacts);
      expect(replay.before).toEqual(CURRENT_DATABASE_SCHEMA);
      expect(replay.after).toEqual(CURRENT_DATABASE_SCHEMA);
      expect(replay.applied).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("resumes cleanly when a Turso commit succeeds but its response is lost", async () => {
    const database = createLegacyTursoDatabase();
    const base = createLocalTursoConnection(database);
    let loseFirstResponse = true;
    const connection: TursoSchemaConnection = {
      ...base,
      transactionAsync<T>(callback: Parameters<TursoSchemaConnection["transactionAsync"]>[0]) {
        return {
          async immediate() {
            const result = await base.transactionAsync(callback).immediate();
            if (loseFirstResponse) {
              loseFirstResponse = false;
              throw new Error("simulated response loss after commit");
            }
            return result as T;
          },
        };
      },
    };
    const artifacts = await loadSchemaUpgradeArtifacts();
    try {
      await expect(applyTursoSchemaUpgrades(connection, artifacts))
        .rejects.toThrow(/response loss after commit/i);
      await expect(applyTursoSchemaUpgrades(base, artifacts)).resolves.toMatchObject({
        before: { version: 50, name: "0050_schema_release_contract" },
        after: CURRENT_DATABASE_SCHEMA,
        applied: [
          { version: 51, name: "0051_orders_checkout_write_path" },
          { version: 52, name: "0052_remove_storefront_cache_queue" },
          { version: 53, name: "0053_checkout_language_authority" },
          { version: 54, name: "0054_cache_invalidation_delivery" },
          { version: 55, name: "0055_cache_invalidation_postgres_bigint" },
          { version: 56, name: "0056_agent_access" },
          { version: 57, name: "0057_agent_browser_handoffs" },
          { version: 58, name: "0058_order_shipping_method_snapshot" },
        ],
      });
    } finally {
      database.close();
    }
  });

  it("refuses a Turso schema change between baseline proof and write-lock acquisition", async () => {
    const database = createLegacyTursoDatabase();
    const base = createLocalTursoConnection(database);
    let injectDrift = true;
    const connection: TursoSchemaConnection = {
      ...base,
      transactionAsync<T>(callback: Parameters<TursoSchemaConnection["transactionAsync"]>[0]) {
        return {
          async immediate() {
            if (injectDrift) {
              injectDrift = false;
              database.exec("CREATE TABLE schema_race (id text PRIMARY KEY)");
            }
            return base.transactionAsync(callback).immediate() as Promise<T>;
          },
        };
      },
    };
    try {
      await expect(applyTursoSchemaUpgrades(
        connection,
        await loadSchemaUpgradeArtifacts(),
      )).rejects.toThrow(/changed before the upgrade lock/i);
      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'scalius_schema_migrations'",
      ).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("rolls back every Turso statement when a migration fails", async () => {
    const database = createLegacyTursoDatabase();
    const connection = createLocalTursoConnection(database);
    const [artifact] = await loadSchemaUpgradeArtifacts();
    const broken = [{
      ...artifact!,
      sqliteStatements: [
        artifact!.sqliteStatements[0]!,
        "THIS IS NOT VALID SQL",
        ...artifact!.sqliteStatements.slice(1),
      ],
    }];
    try {
      await expect(applyTursoSchemaUpgrades(connection, broken)).rejects.toThrow();
      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'scalius_schema_migrations'",
      ).get()).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("refuses an unrecognized Turso legacy schema instead of stamping it current", async () => {
    const database = createLegacyTursoDatabase();
    database.exec("CREATE TABLE unexpected_schema_drift (id text PRIMARY KEY);");
    const connection = createLocalTursoConnection(database);
    try {
      await expect(inspectTursoSchemaUpgrade(
        connection,
        await loadSchemaUpgradeArtifacts(),
      )).rejects.toThrow(/does not match the verified 0049/i);
    } finally {
      database.close();
    }
  });

  it.each(["trigger", "index", "constraint"] as const)(
    "detects a missing Turso 0049 %s during semantic baseline proof",
    async (kind) => {
      const database = createLegacyTursoDatabase();
      const connection = createLocalTursoConnection(database);
      try {
        if (kind === "trigger") {
          const row = database.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name LIMIT 1",
          ).get() as { name: string };
          database.exec(`DROP TRIGGER ${quoteSqliteIdentifier(row.name)}`);
        } else if (kind === "index") {
          const row = database.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1",
          ).get() as { name: string };
          database.exec(`DROP INDEX ${quoteSqliteIdentifier(row.name)}`);
        } else {
          const row = database.prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tax_classes'",
          ).get() as { sql: string };
          const altered = row.sql.replace(
            /,\s*CONSTRAINT "tax_classes_name_length" CHECK\(length\("tax_classes"\."name"\) BETWEEN 1 AND 120\)/,
            "",
          );
          expect(altered).not.toBe(row.sql);
          const dependentSql = database.prepare(`
            SELECT sql FROM sqlite_schema
            WHERE tbl_name = 'tax_classes'
              AND type IN ('index', 'trigger')
              AND sql IS NOT NULL
            ORDER BY type, name
          `).all().map((object) => String(object.sql));
          const replacement = altered
            .replace(
              /^CREATE TABLE [`"]?tax_classes[`"]?/i,
              "CREATE TABLE tax_classes_without_check",
            )
            .replaceAll('"tax_classes".', '"tax_classes_without_check".')
            .replaceAll("`tax_classes`.", "`tax_classes_without_check`.");
          database.exec("PRAGMA foreign_keys = OFF");
          database.exec(replacement);
          database.exec("INSERT INTO tax_classes_without_check SELECT * FROM tax_classes");
          database.exec("DROP TABLE tax_classes");
          database.exec("ALTER TABLE tax_classes_without_check RENAME TO tax_classes");
          for (const sql of dependentSql) database.exec(sql);
          database.exec("PRAGMA foreign_keys = ON");
        }

        await expect(inspectTursoSchemaUpgrade(
          connection,
          await loadSchemaUpgradeArtifacts(),
        )).rejects.toThrow(/does not match the verified 0049/i);
      } finally {
        database.close();
      }
    },
  );

  it("rejects gaps, renamed rows, and future rows in the migration ledger", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    expect(() => validateAppliedSchemaMigrations([
      { version: 51, name: "0051_skipped", sourceSha256: "a".repeat(64) },
    ], artifacts)).toThrow(/diverges at version 50/i);
    expect(() => validateAppliedSchemaMigrations([
      { version: 50, name: "0050_renamed", sourceSha256: artifacts[0]!.sourceSha256 },
    ], artifacts)).toThrow(/diverges at version 50/i);
    expect(() => validateAppliedSchemaMigrations([
      { version: 50, name: artifacts[0]!.name, sourceSha256: "b".repeat(64) },
    ], artifacts)).toThrow(/diverges at version 50/i);
    expect(() => validateAppliedSchemaMigrations([
      { version: 50, name: artifacts[0]!.name, sourceSha256: artifacts[0]!.sourceSha256 },
      { version: 51, name: artifacts[1]!.name, sourceSha256: artifacts[1]!.sourceSha256 },
      { version: 52, name: artifacts[2]!.name, sourceSha256: artifacts[2]!.sourceSha256 },
      { version: 53, name: artifacts[3]!.name, sourceSha256: artifacts[3]!.sourceSha256 },
      { version: 54, name: artifacts[4]!.name, sourceSha256: artifacts[4]!.sourceSha256 },
      { version: 55, name: artifacts[5]!.name, sourceSha256: artifacts[5]!.sourceSha256 },
      { version: 56, name: artifacts[6]!.name, sourceSha256: artifacts[6]!.sourceSha256 },
      { version: 57, name: artifacts[7]!.name, sourceSha256: artifacts[7]!.sourceSha256 },
      { version: 58, name: artifacts[8]!.name, sourceSha256: artifacts[8]!.sourceSha256 },
      { version: 59, name: "0059_future", sourceSha256: "c".repeat(64) },
    ], artifacts)).toThrow(/future row/i);
  });

  it("builds a PostgreSQL lock guard that proves the legacy baseline", async () => {
    const [artifact] = await loadSchemaUpgradeArtifacts();
    const guard = buildPostgresSchemaUpgradeGuard(
      artifact!,
      DATABASE_SCHEMA_LEGACY_BASELINE,
    );
    expect(guard).toContain(POSTGRES_MIGRATION_STATE_REGCLASS);
    expect(guard).toContain(postgresMigrationControlTable(POSTGRES_MIGRATION_STATE_TABLE));
    expect(guard).toContain(DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256);
    expect(guard).toContain(POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE);
    expect(guard).toContain(POSTGRES_SCHEMA_UPGRADE_BUSY_CODE);
    expect(guard).toContain("migration_count IS DISTINCT FROM 0");
    expect(guard).toContain("pg_try_advisory_xact_lock");

    const existingControl = buildPostgresMigrationControlSql({
      migrationId: "migration-test",
      version: SQLITE_TO_POSTGRES_CHECKPOINT_VERSION,
      schemaVersion: DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion,
      schemaSha256: DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256,
      sourceSha256: "a".repeat(64),
      sourceBytes: 1,
      databaseContentSha256: "b".repeat(64),
      target: {
        host: "example.neon.tech",
        port: "5432",
        database: "merchant",
        user: "merchant",
      },
    });
    expect(existingControl).toContain(postgresMigrationControlTable(
      POSTGRES_MIGRATION_STATE_TABLE,
    ));
  });

  it("applies PostgreSQL sidecars in one serializable advisory-locked transaction", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    let appliedCount = 0;
    const query = vi.fn((sql: string) => {
      if (sql.includes("to_regclass('public.scalius_schema_migrations')")) {
        return Promise.resolve(postgresResult([[appliedCount > 0 ? "scalius_schema_migrations" : null]]));
      }
      if (sql.includes("SELECT to_regclass($1)")) {
        return Promise.resolve(postgresResult([[POSTGRES_MIGRATION_STATE_REGCLASS]]));
      }
      if (sql.includes(POSTGRES_MIGRATION_STATE_TABLE)) {
        return Promise.resolve(postgresResult([[
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion,
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256,
          "complete",
        ]]));
      }
      if (sql.includes("FROM scalius_schema_migrations ORDER BY version")) {
        return Promise.resolve(postgresResult(
          artifacts.slice(0, appliedCount).map((artifact) => [
            artifact.version,
            artifact.name,
            artifact.sourceSha256,
          ]),
        ));
      }
      return Promise.resolve(postgresResult([]));
    });
    const transaction = vi.fn(async (queries: PromiseLike<PostgresFullResult>[]) => {
      appliedCount += 1;
      return await Promise.all(queries);
    });
    const connection = { query, transaction } as unknown as PostgresHttpConnection;

    const receipt = await applyPostgresSchemaUpgrades(connection, artifacts);

    expect(receipt.before).toMatchObject(DATABASE_SCHEMA_LEGACY_BASELINE);
    expect(receipt.after).toEqual(CURRENT_DATABASE_SCHEMA);
    expect(receipt.applied.map((artifact) => artifact.name))
      .toEqual(artifacts.map((artifact) => artifact.name));
    expect(transaction).toHaveBeenCalledTimes(artifacts.length);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Array), {
      arrayMode: true,
      fullResults: true,
      isolationLevel: "Serializable",
      readOnly: false,
    });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("pg_try_advisory_xact_lock"))).toBe(true);
  });

  it("treats a concurrently completed PostgreSQL migration as an idempotent replay", async () => {
    const artifacts = await loadSchemaUpgradeArtifacts();
    let appliedCount = 0;
    const query = vi.fn((sql: string) => {
      if (sql.includes("to_regclass('public.scalius_schema_migrations')")) {
        return Promise.resolve(postgresResult([[appliedCount > 0 ? "scalius_schema_migrations" : null]]));
      }
      if (sql.includes("SELECT to_regclass($1)")) {
        return Promise.resolve(postgresResult([[POSTGRES_MIGRATION_STATE_REGCLASS]]));
      }
      if (sql.includes(POSTGRES_MIGRATION_STATE_TABLE)) {
        return Promise.resolve(postgresResult([[
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaBundleVersion,
          DATABASE_SCHEMA_LEGACY_BASELINE.postgresSchemaSha256,
          "complete",
        ]]));
      }
      if (sql.includes("FROM scalius_schema_migrations ORDER BY version")) {
        return Promise.resolve(postgresResult(
          artifacts.slice(0, appliedCount).map((artifact) => [
            artifact.version,
            artifact.name,
            artifact.sourceSha256,
          ]),
        ));
      }
      return Promise.resolve(postgresResult([]));
    });
    const transaction = vi.fn(async () => {
      appliedCount += 1;
      throw Object.assign(new Error("already applied"), {
        code: POSTGRES_SCHEMA_UPGRADE_ALREADY_APPLIED_CODE,
      });
    });
    const connection = { query, transaction } as unknown as PostgresHttpConnection;

    const receipt = await applyPostgresSchemaUpgrades(connection, artifacts);

    expect(receipt.after).toEqual(CURRENT_DATABASE_SCHEMA);
    expect(receipt.applied).toEqual([]);
    expect(transaction).toHaveBeenCalledTimes(artifacts.length);
  });
});
