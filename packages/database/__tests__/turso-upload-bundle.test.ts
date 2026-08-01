import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  appendFile,
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

import { connect } from "@tursodatabase/database";

import { afterEach, describe, expect, it } from "vitest";

import { prepareTursoUploadBundle } from "../scripts/prepare-turso-upload";
import { createProviderSchemaDatabase } from "../scripts/sqlite-provider-schema";
import {
  readTursoUploadBundle,
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
  });

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
    })).rejects.toThrow(/missing table/i);
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
  });
});
