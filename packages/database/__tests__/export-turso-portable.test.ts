import { appendFile, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";

import {
  convertSyncedTursoDatabase,
  exportTursoPortable,
  parseAndAcknowledgeTursoSource,
  pullFrozenTursoSnapshot,
  TURSO_PORTABLE_EXPORT_FILENAME,
  TURSO_PORTABLE_RETIRED_ARCHIVE_FILENAME,
  type TursoPortableExportDependencies,
  type TursoSyncSession,
  verifyTursoPortableExportBundle,
} from "../scripts/export-turso-portable";
import {
  canonicalMigrationDirectory,
  createProviderSchemaDatabase,
} from "../scripts/sqlite-provider-schema";

function syncStats(revision = "opaque-revision-1") {
  return {
    cdcOperations: 0,
    mainWalSize: 0,
    revertWalSize: 0,
    revision,
    networkReceivedBytes: 12_345,
  };
}

describe("portable Turso export", () => {
  it("requires a credential-free URL and exact source-host acknowledgement", () => {
    expect(parseAndAcknowledgeTursoSource(
      "turso://merchant.example.turso.io",
      "merchant.example.turso.io",
    )).toEqual({
      url: "turso://merchant.example.turso.io",
      host: "merchant.example.turso.io",
    });
    expect(() => parseAndAcknowledgeTursoSource(
      "turso://token@merchant.example.turso.io",
      "merchant.example.turso.io",
    )).toThrow(/credential-free/i);
    expect(() => parseAndAcknowledgeTursoSource(
      "turso://merchant.example.turso.io?authToken=secret",
      "merchant.example.turso.io",
    )).toThrow(/credential-free/i);
    expect(() => parseAndAcknowledgeTursoSource(
      "turso://merchant.example.turso.io",
      "different.example.turso.io",
    )).toThrow(/does not exactly match/i);
  });

  it("requires two settled pulls and an unchanged checkpoint revision", async () => {
    const pulls = [true, false, false];
    const session: TursoSyncSession = {
      async pull() {
        return pulls.shift() ?? false;
      },
      async checkpoint() {},
      async stats() {
        return syncStats();
      },
      async close() {},
    };
    await expect(pullFrozenTursoSnapshot(session)).resolves.toMatchObject({
      revision: "opaque-revision-1",
      pullAttempts: 3,
      changedPulls: 1,
    });

    let statsCalls = 0;
    await expect(pullFrozenTursoSnapshot({
      ...session,
      async pull() {
        return false;
      },
      async stats() {
        statsCalls += 1;
        return syncStats(`opaque-revision-${statsCalls}`);
      },
    })).rejects.toThrow(/revision changed/i);
  });

  it("converts a synced database into one ordinary SQLite artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-turso-convert-"));
    const databasePath = join(directory, "sync.sqlite3");
    try {
      const database = new DatabaseSync(databasePath);
      database.exec(`
        CREATE TABLE probe (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          payload BLOB,
          note TEXT
        );
      `);
      database.prepare(
        "INSERT INTO probe (id, sequence, payload, note) VALUES (?, ?, ?, ?)",
      ).run(
        "probe",
        9_223_372_036_854_775_807n,
        Uint8Array.from([0, 255, 16]),
        "line one\nline two",
      );
      database.close();

      await convertSyncedTursoDatabase(databasePath);
      expect(await readdir(directory)).toEqual(["sync.sqlite3"]);
      const converted = new DatabaseSync(databasePath, { readOnly: true });
      const row = converted.prepare(`
        SELECT id, sequence, hex(payload) AS payload, note FROM probe
      `);
      row.setReadBigInts(true);
      expect(row.get()).toEqual({
        id: "probe",
        sequence: 9_223_372_036_854_775_807n,
        payload: "00FF10",
        note: "line one\nline two",
      });
      expect(converted.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      converted.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates and re-verifies a canonical bundle with a lossless retired archive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-turso-export-"));
    const fixturePath = join(directory, "fixture.sqlite3");
    const outputPath = join(directory, "bundle");
    try {
      const fixture = await createProviderSchemaDatabase("turso", fixturePath);
      fixture.exec(`
        CREATE TABLE plugin_state (
          id TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL,
          payload BLOB,
          note TEXT
        );
        CREATE TABLE __new_rate_limit (
          id TEXT PRIMARY KEY,
          key TEXT NOT NULL,
          count INTEGER NOT NULL,
          last_request INTEGER NOT NULL
        );
        CREATE TABLE turso_cdc_version (version INTEGER NOT NULL);
        INSERT INTO turso_cdc_version VALUES (1);
      `);
      fixture.prepare(
        "INSERT INTO plugin_state (id, sequence, payload, note) VALUES (?, ?, ?, ?)",
      ).run(
        "legacy",
        9_223_372_036_854_775_807n,
        Uint8Array.from([0, 255, 16]),
        "line one\nline two",
      );
      fixture.close();

      const dependencies: TursoPortableExportDependencies = {
        async connectSync(options) {
          await copyFile(fixturePath, options.path);
          return {
            async pull() {
              return false;
            },
            async checkpoint() {},
            async stats() {
              return syncStats();
            },
            async close() {},
          };
        },
        async convertSyncedDatabase() {},
      };
      const summary = await exportTursoPortable({
        databaseUrl: "turso://merchant.example.turso.io",
        authToken: "test-token",
        acknowledgedSourceHost: "merchant.example.turso.io",
        outputDirectory: outputPath,
      }, dependencies);
      expect(summary).toMatchObject({
        bundle: outputPath,
        sourceHost: "merchant.example.turso.io",
        sourceRevision: "opaque-revision-1",
      });
      expect(summary.tableCount).toBeGreaterThan(100);
      expect(summary.retiredArchiveSha256).toMatch(/^[a-f0-9]{64}$/);
      expect((await readdir(outputPath)).sort()).toEqual([
        "export-evidence.json",
        TURSO_PORTABLE_RETIRED_ARCHIVE_FILENAME,
        TURSO_PORTABLE_EXPORT_FILENAME,
      ]);

      const verified = await verifyTursoPortableExportBundle(outputPath);
      expect(verified.evidence.normalization.ignoredSourceTables).toContainEqual({
        table: "plugin_state",
        rowCount: 1,
      });
      expect(verified.evidence.normalization.ignoredSourceTables).toContainEqual({
        table: "__new_rate_limit",
        rowCount: 0,
      });
      expect(verified.evidence.normalization.ignoredSourceTables)
        .not.toContainEqual(expect.objectContaining({ table: "turso_cdc_version" }));
      const canonical = new DatabaseSync(verified.sourcePath, { readOnly: true });
      expect(canonical.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type = 'table' AND name = 'plugin_state'
      `).get()).toEqual({ count: 0 });
      canonical.close();

      await appendFile(verified.sourcePath, "tampered");
      await expect(verifyTursoPortableExportBundle(outputPath))
        .rejects.toThrow(/does not match its evidence/i);

      const dirtyFixture = new DatabaseSync(fixturePath);
      dirtyFixture.prepare(`
        INSERT INTO __new_rate_limit (id, key, count, last_request)
        VALUES ('unexpected', 'unexpected', 1, 1)
      `).run();
      dirtyFixture.close();
      await expect(exportTursoPortable({
        databaseUrl: "turso://merchant.example.turso.io",
        authToken: "test-token",
        acknowledgedSourceHost: "merchant.example.turso.io",
        outputDirectory: join(directory, "dirty-bundle"),
      }, dependencies)).rejects.toThrow(/transient tables unexpectedly contain data/i);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("upgrades a recognized older Turso snapshot before canonical export", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scalius-turso-upgrade-"));
    const fixturePath = join(directory, "fixture.sqlite3");
    const outputPath = join(directory, "bundle");
    try {
      const names = (await readdir(canonicalMigrationDirectory))
        .filter((name) => /^\d{4}_.+\.sql$/.test(name))
        .sort((left, right) => left.localeCompare(right));
      const sourceMigrationCount = 46;
      const fixture = new DatabaseSync(fixturePath);
      for (const name of names.slice(0, sourceMigrationCount)) {
        fixture.exec(compileSqliteMigrationForProvider(
          await readFile(join(canonicalMigrationDirectory, name), "utf8"),
          "turso",
        ));
      }
      fixture.exec(`
        INSERT INTO products (id, name, price, slug)
        VALUES ('older-product', 'Older product', 1000, 'older-product');
      `);
      fixture.close();

      const dependencies: TursoPortableExportDependencies = {
        async connectSync(options) {
          await copyFile(fixturePath, options.path);
          return {
            async pull() {
              return false;
            },
            async checkpoint() {},
            async stats() {
              return syncStats("older-snapshot-revision");
            },
            async close() {},
          };
        },
        async convertSyncedDatabase() {},
      };
      await exportTursoPortable({
        databaseUrl: "turso://merchant.example.turso.io",
        authToken: "test-token",
        acknowledgedSourceHost: "merchant.example.turso.io",
        outputDirectory: outputPath,
      }, dependencies);

      const verified = await verifyTursoPortableExportBundle(outputPath);
      expect(verified.evidence.normalization.schemaUpgrade).toMatchObject({
        version: "scalius-sqlite-snapshot-schema-upgrade/v1",
        provider: "turso",
        sourceMigrationCount,
        targetMigrationCount: names.length,
        appliedMigrations: names.slice(sourceMigrationCount).map((name) => ({ name })),
        integrity: "ok",
        foreignKeyViolations: 0,
      });
      const canonical = new DatabaseSync(verified.sourcePath, { readOnly: true });
      expect(canonical.prepare(`
        SELECT name FROM products WHERE id = 'older-product'
      `).get()).toEqual({ name: "Older product" });
      expect(canonical.prepare(`
        SELECT revision FROM checkout_authority WHERE id = 'default'
      `).get()).toEqual({ revision: 1 });
      canonical.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
