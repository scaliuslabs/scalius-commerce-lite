import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { DatabaseSync } from "node:sqlite";

import { connect } from "@tursodatabase/database";

import { afterEach, describe, expect, it } from "vitest";

import { prepareTursoUploadBundle } from "../scripts/prepare-turso-upload";
import {
  D1_PORTABLE_EXPORT_EVIDENCE_FILENAME,
  D1_PORTABLE_EXPORT_FILENAME,
  D1_PORTABLE_EXPORT_VERSION,
} from "../scripts/export-d1-portable";
import { normalizeD1ExportToTursoDatabase } from "../scripts/normalize-d1-export-core";
import {
  createProviderSchemaDatabase,
  readApplicationTableNames,
} from "../scripts/sqlite-provider-schema";
import {
  readTursoUploadBundle,
  sha256File,
  type TursoUploadBundleEvidence,
  verifyTursoUploadBundleFiles,
} from "../scripts/turso-upload-bundle";

const workingDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "scalius-upload-test-"));
  workingDirectories.push(directory);
  return directory;
}

async function dumpSqlite(databasePath: string, outputPath: string): Promise<void> {
  const child = spawn("sqlite3", [databasePath, ".dump"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code) => {
      if (code === 0) resolveExit();
      else rejectExit(new Error(`sqlite3 dump failed: ${stderr}`));
    });
  });
  await Promise.all([
    pipeline(
      child.stdout,
      createWriteStream(outputPath, { flags: "wx", mode: 0o600 }),
    ),
    exited,
  ]);
}

async function createSourceExport(directory: string): Promise<string> {
  const databasePath = join(directory, "source.sqlite3");
  const exportPath = join(directory, "source.sql");
  const database = await createProviderSchemaDatabase("d1", databasePath);
  try {
    database.exec(`
      INSERT INTO products (id, name, price, slug)
      VALUES ('product_upload_test', 'Upload test product', 1250, 'upload-test-product');
      INSERT INTO product_variants (id, product_id, sku, price, stock, is_default)
      VALUES ('variant_upload_test', 'product_upload_test', 'UPLOAD-TEST-1', 1250, 25, 1);
      INSERT INTO settings (id, key, value, type, category, updated_at)
      VALUES (
        'legacy_timestamp_setting',
        'legacy_timestamp_setting',
        'true',
        'boolean',
        'test',
        '2026-03-03 01:40:36'
      );
    `);
  } finally {
    database.close();
  }
  await dumpSqlite(databasePath, exportPath);
  return exportPath;
}

afterEach(async () => {
  await Promise.all(workingDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("native Turso upload bundle", () => {
  it("binds preparation to one verified bookmark-fenced D1 export", async () => {
    const directory = await temporaryDirectory();
    const sourceExport = await createSourceExport(directory);
    const exportBundle = join(directory, "d1-export");
    await mkdir(exportBundle, { mode: 0o700 });
    const bundledSource = join(exportBundle, D1_PORTABLE_EXPORT_FILENAME);
    await copyFile(sourceExport, bundledSource);
    const source = await readFile(bundledSource);
    const schema = await createProviderSchemaDatabase("d1");
    const tables = readApplicationTableNames(schema);
    schema.close();
    const exportEvidence = {
      version: D1_PORTABLE_EXPORT_VERSION,
      database: "merchant-d1",
      bookmark: "bookmark-fenced-snapshot",
      tables,
      retiredTables: [],
      tableSetSha256: createHash("sha256")
        .update(tables.join("\n"))
        .digest("hex"),
      schemaObjectCount: 0,
      schemaObjectSetSha256: createHash("sha256")
        .update("[]")
        .digest("hex"),
      artifact: {
        filename: D1_PORTABLE_EXPORT_FILENAME,
        bytes: source.byteLength,
        sha256: createHash("sha256").update(source).digest("hex"),
      },
    };
    await writeFile(
      join(exportBundle, D1_PORTABLE_EXPORT_EVIDENCE_FILENAME),
      `${JSON.stringify(exportEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );

    const preparedPath = join(directory, "prepared");
    const summary = await prepareTursoUploadBundle({
      exportBundle,
      outputDirectory: preparedPath,
      sqliteBinary: "sqlite3",
    });
    const prepared = await verifyTursoUploadBundleFiles(preparedPath);
    expect(summary.sourceExportReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.evidence.source.portableExport).toEqual({
      version: D1_PORTABLE_EXPORT_VERSION,
      database: "merchant-d1",
      snapshotRef: "bookmark-fenced-snapshot",
      evidenceSha256: summary.sourceExportReceiptSha256,
    });

    await appendFile(bundledSource, "-- tampered after export\n");
    await expect(prepareTursoUploadBundle({
      exportBundle,
      outputDirectory: join(directory, "tampered-prepared"),
      sqliteBinary: "sqlite3",
    })).rejects.toThrow(/source artifact does not match/i);
  }, 30_000);

  it("publishes one private atomic bundle with independently verifiable data", async () => {
    const directory = await temporaryDirectory();
    const sourceExport = await createSourceExport(directory);
    const bundlePath = join(directory, "merchant-turso-upload");

    const summary = await prepareTursoUploadBundle({
      input: sourceExport,
      outputDirectory: bundlePath,
      sqliteBinary: "sqlite3",
    });
    const bundle = await verifyTursoUploadBundleFiles(bundlePath);

    expect(summary.bundle).toBe(bundlePath);
    expect(summary.tableCount).toBeGreaterThan(100);
    expect(summary.rowCount).toBeGreaterThan(1);
    expect(summary.sourceFingerprint).toBe(
      bundle.evidence.portabilityManifest.fingerprint,
    );
    expect(summary.retiredTableCount).toBe(0);
    expect(summary.retiredRowCount).toBe(0);
    expect(bundle.evidence.retiredSchemaArchive).toBeNull();
    expect(bundle.retiredSchemaArchivePath).toBeNull();
    expect(bundle.evidence.artifact.pragmas).toEqual({
      pageSize: 4096,
      journalMode: "mvcc",
      autoVacuum: 0,
      encoding: "UTF-8",
    });
    expect(bundle.evidence.artifact.engine).toBe("turso-mvcc");
    expect((await stat(bundle.bundlePath)).mode & 0o777).toBe(0o700);
    expect((await stat(bundle.databasePath)).mode & 0o777).toBe(0o600);
    expect((await stat(bundle.evidencePath)).mode & 0o777).toBe(0o600);

    await Promise.all(["-wal", "-log"].map((suffix) =>
      writeFile(`${bundle.databasePath}${suffix}`, new Uint8Array(), {
        flag: "wx",
        mode: 0o600,
      }),
    ));
    const target = await connect(bundle.databasePath, {
      fileMustExist: true,
      readonly: true,
    });
    try {
      expect((await target.get(
        "SELECT name FROM products WHERE id = ?",
        "product_upload_test",
      ))?.name).toBe("Upload test product");
      expect((await target.get(
        "SELECT stock FROM product_variants WHERE id = ?",
        "variant_upload_test",
      ))?.stock).toBe(25);
      expect(await target.get(
        "SELECT updated_at FROM settings WHERE id = ?",
        "legacy_timestamp_setting",
      )).toEqual({ updated_at: 1_772_502_036 });
      expect((await target.get(
        "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND upper(sql) LIKE '%VIRTUAL TABLE%'",
      ))?.count).toBe(0);
      expect((await target.get("PRAGMA journal_mode"))?.journal_mode).toBe("mvcc");
      expect((await target.get("PRAGMA integrity_check"))?.integrity_check).toBe("ok");
      expect(await target.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      await target.close();
      await Promise.all(["-wal", "-log", "-shm", "-tshm"].map((suffix) =>
        rm(`${bundle.databasePath}${suffix}`, { force: true }),
      ));
    }

    const evidenceText = await readFile(bundle.evidencePath, "utf8");
    expect(evidenceText).not.toContain(directory);
    await expect(prepareTursoUploadBundle({
      input: sourceExport,
      outputDirectory: bundlePath,
      sqliteBinary: "sqlite3",
    })).rejects.toThrow(/refusing to overwrite/i);
  }, 30_000);

  it("fails closed, removes partial output, and detects artifact tampering", async () => {
    const directory = await temporaryDirectory();
    const brokenExport = join(directory, "broken.sql");
    const brokenBundle = join(directory, "broken-bundle");
    await writeFile(
      brokenExport,
      "CREATE TABLE unrelated (id TEXT PRIMARY KEY);\n",
      { mode: 0o600 },
    );

    await expect(prepareTursoUploadBundle({
      input: brokenExport,
      outputDirectory: brokenBundle,
      sqliteBinary: "sqlite3",
    })).rejects.toThrow(/missing table|unexpected noncanonical tables/i);
    await expect(access(brokenBundle)).rejects.toThrow();
    expect((await readdir(directory)).some((name) =>
      name.startsWith(".scalius-turso-upload-"),
    )).toBe(false);

    const sourceExport = await createSourceExport(directory);
    const bundlePath = join(directory, "tamper-bundle");
    await prepareTursoUploadBundle({
      input: sourceExport,
      outputDirectory: bundlePath,
      sqliteBinary: "sqlite3",
    });
    const bundle = await readTursoUploadBundle(bundlePath);
    await appendFile(bundle.databasePath, Buffer.from([0]));
    await expect(verifyTursoUploadBundleFiles(bundlePath))
      .rejects.toThrow(/does not match evidence/i);
  }, 20_000);

  it("keeps the active schema clean and losslessly archives non-empty retired tables", async () => {
    const directory = await temporaryDirectory();
    const emptyLegacyExport = await createSourceExport(directory);
    await appendFile(
      emptyLegacyExport,
      "\nCREATE TABLE plugin_routes (id TEXT PRIMARY KEY);\n",
    );
    const emptyLegacyBundle = join(directory, "empty-legacy-bundle");
    await prepareTursoUploadBundle({
      input: emptyLegacyExport,
      outputDirectory: emptyLegacyBundle,
      sqliteBinary: "sqlite3",
    });
    const emptyLegacy = await readTursoUploadBundle(emptyLegacyBundle);
    const evidence = emptyLegacy.evidence;
    expect(evidence.normalization.ignoredSourceTables).toEqual([{
      table: "plugin_routes",
      rowCount: 0,
    }]);
    expect(evidence.retiredSchemaArchive).toBeNull();
    expect(emptyLegacy.retiredSchemaArchivePath).toBeNull();

    const nonEmptyDirectory = await temporaryDirectory();
    const nonEmptyLegacyExport = await createSourceExport(nonEmptyDirectory);
    await appendFile(
      nonEmptyLegacyExport,
      `
CREATE TABLE plugin_routes (
  id TEXT PRIMARY KEY,
  payload BLOB NOT NULL,
  sequence INTEGER NOT NULL,
  note TEXT
);
CREATE INDEX plugin_routes_sequence_idx ON plugin_routes (sequence);
CREATE TRIGGER plugin_routes_note_guard
BEFORE INSERT ON plugin_routes
WHEN NEW.note = ''
BEGIN
  SELECT RAISE(ABORT, 'note cannot be empty');
END;
INSERT INTO plugin_routes VALUES (
  'legacy-route',
  X'00FF10',
  9223372036854775807,
  'line one
line two'
);
CREATE TABLE scalius_turso_control_a (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  value INTEGER NOT NULL
);
INSERT INTO scalius_turso_control_a VALUES ('probe-row', 'retired-run', 7);
`,
    );
    const explicitTarget = join(nonEmptyDirectory, "no-archive-target.sqlite3");
    await expect(normalizeD1ExportToTursoDatabase({
      input: nonEmptyLegacyExport,
      targetDatabasePath: explicitTarget,
      sqliteBinary: "sqlite3",
    })).rejects.toThrow(/require an explicit archive.*plugin_routes \(1 rows\)/i);
    await expect(access(explicitTarget)).rejects.toThrow();

    const nonEmptyBundlePath = join(nonEmptyDirectory, "non-empty-legacy-bundle");
    const nonEmptySummary = await prepareTursoUploadBundle({
      input: nonEmptyLegacyExport,
      outputDirectory: nonEmptyBundlePath,
      sqliteBinary: "sqlite3",
    });
    const nonEmptyBundle = await verifyTursoUploadBundleFiles(nonEmptyBundlePath);
    const archiveEvidence = nonEmptyBundle.evidence.retiredSchemaArchive;
    expect(nonEmptySummary.retiredTableCount).toBe(2);
    expect(nonEmptySummary.retiredRowCount).toBe(2);
    expect(archiveEvidence).toMatchObject({
      version: "scalius-retired-schema-archive/v1",
      filename: "retired-schema-archive.sqlite3",
      tableCount: 2,
      rowCount: 2,
      integrity: "ok",
      tables: [
        { table: "plugin_routes", rowCount: 1 },
        { table: "scalius_turso_control_a", rowCount: 1 },
      ],
    });
    expect(nonEmptyBundle.retiredSchemaArchivePath).not.toBeNull();
    expect((await stat(nonEmptyBundle.retiredSchemaArchivePath!)).mode & 0o777)
      .toBe(0o600);

    const archive = new DatabaseSync(nonEmptyBundle.retiredSchemaArchivePath!, {
      readOnly: true,
    });
    await Promise.all(["-wal", "-log"].map((suffix) =>
      writeFile(`${nonEmptyBundle.databasePath}${suffix}`, new Uint8Array(), {
        flag: "wx",
        mode: 0o600,
      }),
    ));
    const active = await connect(nonEmptyBundle.databasePath, {
      fileMustExist: true,
      readonly: true,
    });
    try {
      const archivedRow = archive.prepare(`
        SELECT id, hex(payload) AS payload, sequence, note
        FROM plugin_routes
      `);
      archivedRow.setReadBigInts(true);
      expect(archivedRow.get()).toEqual({
        id: "legacy-route",
        payload: "00FF10",
        sequence: 9_223_372_036_854_775_807n,
        note: "line one\nline two",
      });
      expect(archive.prepare(`
        SELECT row_count, content_sha256
        FROM _scalius_retired_schema_tables
        WHERE table_name = 'plugin_routes'
      `).get()).toMatchObject({
        row_count: 1,
        content_sha256: archiveEvidence!.tables[0]!.contentSha256,
      });
      expect(archive.prepare(`
        SELECT object_type, object_name
        FROM _scalius_retired_schema_objects
        WHERE table_name = 'plugin_routes'
        ORDER BY object_type, object_name
      `).all()).toEqual([
        { object_type: "index", object_name: "plugin_routes_sequence_idx" },
        { object_type: "trigger", object_name: "plugin_routes_note_guard" },
      ]);
      expect(await active.get(`
        SELECT COUNT(*) AS count
        FROM sqlite_schema
        WHERE type = 'table' AND name = 'plugin_routes'
      `)).toEqual({ count: 0 });
    } finally {
      archive.close();
      await active.close();
      await Promise.all(["-wal", "-log", "-shm", "-tshm"].map((suffix) =>
        rm(`${nonEmptyBundle.databasePath}${suffix}`, { force: true }),
      ));
    }

    const tamperedArchive = new DatabaseSync(
      nonEmptyBundle.retiredSchemaArchivePath!,
    );
    try {
      tamperedArchive.prepare(`
        UPDATE plugin_routes SET note = 'tampered' WHERE id = 'legacy-route'
      `).run();
    } finally {
      tamperedArchive.close();
    }
    await expect(verifyTursoUploadBundleFiles(nonEmptyBundlePath))
      .rejects.toThrow(/retired schema archive does not match evidence/i);
    const tamperedHash = await sha256File(nonEmptyBundle.retiredSchemaArchivePath!);
    const tamperedEvidence = JSON.parse(
      await readFile(nonEmptyBundle.evidencePath, "utf8"),
    ) as TursoUploadBundleEvidence;
    tamperedEvidence.retiredSchemaArchive!.bytes = tamperedHash.bytes;
    tamperedEvidence.retiredSchemaArchive!.sha256 = tamperedHash.sha256;
    await writeFile(
      nonEmptyBundle.evidencePath,
      `${JSON.stringify(tamperedEvidence, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(verifyTursoUploadBundleFiles(nonEmptyBundlePath))
      .rejects.toThrow(/content fingerprint differs.*plugin_routes/i);

    const unknownDirectory = await temporaryDirectory();
    const unknownExport = await createSourceExport(unknownDirectory);
    await appendFile(
      unknownExport,
      "\nCREATE TABLE unexplained_extension (id TEXT PRIMARY KEY);\n",
    );
    await expect(prepareTursoUploadBundle({
      input: unknownExport,
      outputDirectory: join(unknownDirectory, "unknown-table-bundle"),
      sqliteBinary: "sqlite3",
    })).rejects.toThrow(/unexpected noncanonical tables.*unexplained_extension/i);
  }, 120_000);

  it("trusts an exact release ledger when a historical D1 schema differs physically", async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, "historical-d1.sqlite3");
    const exportPath = join(directory, "historical-d1.sql");
    const targetPath = join(directory, "normalized.sqlite3");
    const database = await createProviderSchemaDatabase("d1", databasePath);
    try {
      // Production D1 databases can retain an older physical index shape even
      // when their provider-neutral release ledger is current. Normalization
      // rebuilds a canonical target, so exact ledger authority is the safe
      // migration boundary instead of byte-identical sqlite_schema text.
      database.exec("DROP INDEX IF EXISTS products_status_idx");
    } finally {
      database.close();
    }
    await dumpSqlite(databasePath, exportPath);

    const summary = await normalizeD1ExportToTursoDatabase({
      input: exportPath,
      targetDatabasePath: targetPath,
      sqliteBinary: "sqlite3",
    });

    expect(summary.schemaUpgrade.sourceMigrationCount).toBe(
      summary.schemaUpgrade.targetMigrationCount,
    );
    expect(summary.schemaUpgrade.appliedMigrations).toEqual([]);
    expect(summary.foreignKeyViolations).toBe(0);
  }, 30_000);
});
