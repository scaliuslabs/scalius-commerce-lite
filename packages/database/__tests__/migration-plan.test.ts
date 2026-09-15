import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import {
  assertD1MigrationPlanCurrent,
  buildD1LedgerInsert,
  buildD1MigrationPlan,
  buildReleaseLedgerPayload,
  D1_MIGRATION_PLAN_CONTRACT,
  D1_MIGRATIONS_LEDGER_DDL,
  D1_MIGRATIONS_LEDGER_LIST_SQL,
  D1_MIGRATIONS_LEDGER_TABLE,
  FIRST_RELEASE_LEDGER_VERSION,
  listPendingD1Migrations,
  SCALIUS_SCHEMA_LEDGER_TABLE,
  sha256Hex,
  splitD1MigrationStatements,
  type D1MigrationFile,
  type D1MigrationPlan,
} from "../src/migration-plan";
import {
  CURRENT_DATABASE_SCHEMA,
  CURRENT_DATABASE_SCHEMA_MIGRATIONS,
} from "../src/schema-contract";
import { splitSchemaMigrationStatements } from "../src/schema-upgrade";
import { loadCanonicalD1MigrationPlan } from "../scripts/print-migration-plan";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationsDirectory = resolve(import.meta.dirname, "../migrations");
const wranglerBundlePath = join(
  repositoryRoot,
  "apps/api/node_modules/wrangler/wrangler-dist/cli.js",
);

function readCanonicalFiles(): readonly D1MigrationFile[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(migrationsDirectory, name), "utf8"),
    }));
}

async function syntheticReleaseFile(
  version: number,
  slug: string,
  bodyStatements: readonly string[],
): Promise<D1MigrationFile> {
  const name = `${String(version).padStart(4, "0")}_${slug}`;
  const sourceSha256 = await sha256Hex(buildReleaseLedgerPayload(bodyStatements));
  const insert = `INSERT INTO \`${SCALIUS_SCHEMA_LEDGER_TABLE}\` (\`version\`, \`name\`, `
    + `\`source_sha256\`) VALUES (${version}, '${name}', '${sourceSha256}');`;
  return {
    name: `${name}.sql`,
    sql: `${[...bodyStatements, insert].join("\n--> statement-breakpoint\n")}\n`,
  };
}

function syntheticChain(count: number): D1MigrationFile[] {
  return Array.from({ length: count }, (_, version) => ({
    name: `${String(version).padStart(4, "0")}_step_${version}.sql`,
    sql: `CREATE TABLE t${version} (id INTEGER PRIMARY KEY);\n--> statement-breakpoint\n`
      + `INSERT INTO t${version} (id) VALUES (${version});\n`,
  }));
}

describe("D1 migration plan builder", () => {
  it("orders migrations by numeric prefix regardless of input order", async () => {
    const files = syntheticChain(3).reverse();
    const plan = await buildD1MigrationPlan(files);

    expect(plan.contract).toBe(D1_MIGRATION_PLAN_CONTRACT);
    expect(plan.ledgerTable).toBe(D1_MIGRATIONS_LEDGER_TABLE);
    expect(plan.ledgerDdl).toBe(D1_MIGRATIONS_LEDGER_DDL);
    expect(plan.ledgerListSql).toBe(D1_MIGRATIONS_LEDGER_LIST_SQL);
    expect(plan.releaseLedgerTable).toBe(SCALIUS_SCHEMA_LEDGER_TABLE);
    expect(plan.expectedSchema).toEqual(CURRENT_DATABASE_SCHEMA);
    expect(plan.migrations.map((migration) => migration.version)).toEqual([0, 1, 2]);
    expect(plan.migrations[1]).toMatchObject({
      version: 1,
      name: "0001_step_1",
      file: "0001_step_1.sql",
      fileSha256: await sha256Hex(files[1]!.sql),
      statements: [
        "CREATE TABLE t1 (id INTEGER PRIMARY KEY);",
        "INSERT INTO t1 (id) VALUES (1);",
      ],
      ledgerInsert: `INSERT INTO "d1_migrations" (name)\nvalues ('0001_step_1.sql');`,
      releaseLedger: null,
    });
  });

  it("rejects gaps, duplicates, a chain not starting at 0000, and bad names", async () => {
    const [first, second, third] = syntheticChain(3);
    await expect(buildD1MigrationPlan([first!, third!]))
      .rejects.toThrow(/not contiguous at 0001/);
    await expect(buildD1MigrationPlan([first!, second!, { ...second!, name: "0001_other.sql" }]))
      .rejects.toThrow(/not contiguous at 0002/);
    await expect(buildD1MigrationPlan([second!, third!]))
      .rejects.toThrow(/not contiguous at 0000/);
    await expect(buildD1MigrationPlan([{ ...first!, name: "1_bad.sql" }]))
      .rejects.toThrow(/Invalid D1 migration file name/);
    await expect(buildD1MigrationPlan([{ ...first!, name: "0000_Bad-Name.sql" }]))
      .rejects.toThrow(/Invalid D1 migration file name/);
    await expect(buildD1MigrationPlan([{ ...first!, sql: "\n--> statement-breakpoint\n" }]))
      .rejects.toThrow(/at least one statement/);
    await expect(buildD1MigrationPlan([])).rejects.toThrow(/at least one migration/);
  });

  it("escapes single quotes in the Wrangler ledger insert like Wrangler does", () => {
    expect(buildD1LedgerInsert("0001_it's.sql"))
      .toBe(`INSERT INTO "d1_migrations" (name)\nvalues ('0001_it''s.sql');`);
  });

  it("splits the real chain exactly like the schema upgrade runner", () => {
    // splitSchemaMigrationStatements additionally rejects transaction-unsafe
    // statements because it guards release artifacts (0050+). Legacy Drizzle
    // table rebuilds wrap themselves in PRAGMA foreign_keys=OFF/ON, which D1
    // executes as ordinary statements, so those files are compared against the
    // same split without the guard.
    let compared = 0;
    for (const file of readCanonicalFiles()) {
      const version = Number(file.name.slice(0, 4));
      const statements = splitD1MigrationStatements(file.sql);
      try {
        expect(statements, file.name).toEqual(splitSchemaMigrationStatements(file.sql));
        compared += 1;
      } catch (error) {
        expect(version, file.name).toBeLessThan(FIRST_RELEASE_LEDGER_VERSION);
        expect((error as Error).message, file.name).toMatch(/transaction-safe/);
        expect(statements.some((statement) => /^PRAGMA\s+foreign_keys\b/i.test(statement)), file.name)
          .toBe(true);
        expect(statements, file.name).toEqual(
          file.sql.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean),
        );
      }
    }
    expect(compared).toBeGreaterThanOrEqual(CURRENT_DATABASE_SCHEMA_MIGRATIONS.length);
  });

  it("requires release-ledger migrations to end with their exact ledger row", async () => {
    const baseline = syntheticChain(FIRST_RELEASE_LEDGER_VERSION);
    const body = ["CREATE TABLE release_t (id INTEGER PRIMARY KEY);"];
    const release = await syntheticReleaseFile(FIRST_RELEASE_LEDGER_VERSION, "release", body);
    const plan = await buildD1MigrationPlan([...baseline, release]);
    const planned = plan.migrations.at(-1)!;

    expect(planned.releaseLedger).toEqual({
      version: FIRST_RELEASE_LEDGER_VERSION,
      name: `${String(FIRST_RELEASE_LEDGER_VERSION).padStart(4, "0")}_release`,
      sourceSha256: await sha256Hex(buildReleaseLedgerPayload(body)),
    });
    expect(planned.releaseLedger!.sourceSha256).not.toBe(planned.fileSha256);

    const missingInsert = { ...release, sql: `${body[0]}\n` };
    await expect(buildD1MigrationPlan([...baseline, missingInsert]))
      .rejects.toThrow(/exactly one scalius_schema_migrations insert/);

    const wrongDigest = {
      ...release,
      sql: release.sql.replace(/'[a-f0-9]{64}'/, `'${"0".repeat(64)}'`),
    };
    await expect(buildD1MigrationPlan([...baseline, wrongDigest]))
      .rejects.toThrow(/exact identity and source digest/);

    const insertNotLast = {
      ...release,
      sql: `${release.sql}--> statement-breakpoint\nCREATE TABLE late (id INTEGER);\n`,
    };
    await expect(buildD1MigrationPlan([...baseline, insertNotLast]))
      .rejects.toThrow(/exactly one scalius_schema_migrations insert/);
  });

  it("computes pending migrations only from an exact ordered ledger prefix", async () => {
    const plan = await buildD1MigrationPlan(syntheticChain(4));
    const files = plan.migrations.map((migration) => migration.file);

    expect(listPendingD1Migrations(plan, []).map((migration) => migration.file))
      .toEqual(files);
    expect(listPendingD1Migrations(plan, files.slice(0, 2)).map((migration) => migration.file))
      .toEqual(files.slice(2));
    expect(listPendingD1Migrations(plan, files)).toEqual([]);

    expect(() => listPendingD1Migrations(plan, ["0000_step_0.sql", "0002_step_2.sql"]))
      .toThrow(/diverges at row 2/);
    expect(() => listPendingD1Migrations(plan, ["0001_step_1.sql"]))
      .toThrow(/diverges at row 1/);
    expect(() => listPendingD1Migrations(plan, ["0000_step_0.sql", "0000_step_0.sql"]))
      .toThrow(/diverges at row 2/);
    expect(() => listPendingD1Migrations(plan, ["0000_step_0.sql", "9999_foreign.sql"]))
      .toThrow(/unknown migration "9999_foreign.sql"/);
    expect(() => listPendingD1Migrations(plan, [...files, ...files]))
      .toThrow(/more rows than the plan/);
  });

  it("fails closed when the plan does not end at the runtime release", async () => {
    const stale = await buildD1MigrationPlan(syntheticChain(2));
    expect(() => assertD1MigrationPlanCurrent(stale))
      .toThrow(new RegExp(`ends at 0001_step_1; expected ${CURRENT_DATABASE_SCHEMA.name}`));
  });
});

describe("D1 migration plan for the canonical chain", () => {
  it("ends at CURRENT_DATABASE_SCHEMA and records every release-ledger row", async () => {
    const plan = await loadCanonicalD1MigrationPlan();
    const latest = plan.migrations.at(-1)!;

    expect(plan.migrations).toHaveLength(CURRENT_DATABASE_SCHEMA.version + 1);
    expect({ version: latest.version, name: latest.name }).toEqual(CURRENT_DATABASE_SCHEMA);
    expect(plan.expectedSchema).toEqual(CURRENT_DATABASE_SCHEMA);

    const releases = plan.migrations.filter((migration) => migration.releaseLedger);
    expect(releases.map((migration) => migration.releaseLedger))
      .toEqual(CURRENT_DATABASE_SCHEMA_MIGRATIONS);
    for (const migration of plan.migrations) {
      const ledgerStatements = migration.statements.filter((statement) =>
        /^INSERT\s+INTO\s+[`"]?scalius_schema_migrations[`"]?\b/i.test(statement),
      );
      if (migration.version < FIRST_RELEASE_LEDGER_VERSION) {
        expect(migration.releaseLedger, migration.file).toBeNull();
        expect(ledgerStatements, migration.file).toEqual([]);
        continue;
      }
      expect(ledgerStatements, migration.file).toHaveLength(1);
      expect(migration.statements.at(-1), migration.file).toBe(ledgerStatements[0]);
      expect(ledgerStatements[0], migration.file)
        .toContain(`'${migration.releaseLedger!.sourceSha256}'`);
      expect(migration.releaseLedger!.sourceSha256, migration.file)
        .toBe(await sha256Hex(buildReleaseLedgerPayload(migration.statements.slice(0, -1))));
    }
  });

  it("matches the Wrangler bundle's ledger DDL and insert shape", () => {
    if (!existsSync(wranglerBundlePath)) {
      it.skip("Wrangler bundle is not installed", () => undefined);
      return;
    }
    const bundle = readFileSync(wranglerBundlePath, "utf8");

    expect(bundle).toContain('DEFAULT_MIGRATION_TABLE = "d1_migrations";');
    expect(bundle).toContain(
      "function escapeIdentifier(id) {\n  return `\"${id.replace(/\"/g, '\"\"')}\"`;\n}",
    );
    const ddlTemplate = D1_MIGRATIONS_LEDGER_DDL.replace(
      `"${D1_MIGRATIONS_LEDGER_TABLE}"`,
      "${escapedTableName}",
    );
    expect(bundle).toContain(`return \`${ddlTemplate}\`;`);
    const listTemplate = D1_MIGRATIONS_LEDGER_LIST_SQL.replace(
      `"${D1_MIGRATIONS_LEDGER_TABLE}"`,
      "${escapedTableName}",
    );
    expect(bundle).toContain(`return \`${listTemplate}\`;`);
    expect(bundle).toContain(
      "return `${migration}\nINSERT INTO ${escapedTableName} (name)\n"
      + "values ('${migrationName.replace(/'/g, \"''\")}');`;",
    );
    expect(bundle).toContain("return normalizeRelativePath(`${migrationsDir}/*.sql`);");
    expect(bundle).toContain("if (!appliedMigrations.includes(migration)) {");
  });

  it("applies the plan into SQLite and leaves nothing pending for Wrangler", async () => {
    const files = readCanonicalFiles();
    // `sqlite-provider-schema.ts` applies the chain through
    // compileSqliteMigrationForProvider(sql, "d1"), which is the identity for
    // D1 (fts5, recursive CTE, and WITHOUT ROWID are all supported), so the
    // plan is built from the raw files Wrangler would execute. Prove it here.
    for (const file of files) {
      expect(compileSqliteMigrationForProvider(file.sql, "d1"), file.name).toBe(file.sql);
    }
    const plan: D1MigrationPlan = await buildD1MigrationPlan(files);
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(plan.ledgerDdl);
      for (const migration of plan.migrations) {
        for (const statement of migration.statements) database.exec(statement);
        database.exec(migration.ledgerInsert);
      }

      const appliedNames = database
        .prepare(plan.ledgerListSql)
        .all()
        .map((row) => String(row.name));
      expect(appliedNames).toEqual(plan.migrations.map((migration) => migration.file));
      expect(listPendingD1Migrations(plan, appliedNames)).toEqual([]);

      const releaseRows = database
        .prepare(
          `SELECT version, name, source_sha256 AS sourceSha256 FROM ${plan.releaseLedgerTable} ORDER BY version`,
        )
        .all()
        .map((row) => ({
          version: Number(row.version),
          name: String(row.name),
          sourceSha256: String(row.sourceSha256),
        }));
      expect(releaseRows).toEqual(CURRENT_DATABASE_SCHEMA_MIGRATIONS);
      expect(releaseRows.at(-1)!.version).toBe(CURRENT_DATABASE_SCHEMA.version);
    } finally {
      database.close();
    }
  });
});
