/**
 * `pnpm demo:store --export <dir>`: the headless demo-store export.
 *
 * Export mode turns a database the demo store has already been applied to into
 * a portable seed bundle another deployment can load. It is the mirror image of
 * `--apply`: no admin origin, no credentials, no prompts, no network, and no
 * write path to a live store. Its only input is a SQLite file, opened
 * read-only, and its only output is a directory of files.
 *
 * The orchestration is deliberately linear: open read-only, build and validate
 * the whole bundle in memory, prove the output directory belongs to this
 * exporter, then write. Every failure mode lands before the first write.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import { buildDemoStoreSeedBundle } from "./bundle.mjs";
import { openSourceDatabase } from "./source.mjs";
import { assertBundleDirectoryUsable, writeBundle } from "./write.mjs";
import { formatSchemaRevision } from "./schema-revision.mjs";

async function assertSourceDatabaseFile(sourceDatabasePath) {
  let stats;
  try {
    stats = await stat(sourceDatabasePath);
  } catch {
    throw new Error(
      `No SQLite database exists at ${sourceDatabasePath}. --source-db must name the local SQLite file the demo store was applied to.`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(
      `${sourceDatabasePath} is not a file. --source-db must name the local SQLite file the demo store was applied to.`,
    );
  }
}

export async function runDemoStoreExport({
  exportDir,
  sourceDb,
  mediaSourceDir = null,
  openDatabaseImpl = openSourceDatabase,
}) {
  const sourceDatabasePath = path.resolve(sourceDb);
  const mediaSourceDirectory = mediaSourceDir === null ? null : path.resolve(mediaSourceDir);
  await assertSourceDatabaseFile(sourceDatabasePath);
  if (mediaSourceDirectory !== null) {
    let stats;
    try {
      stats = await stat(mediaSourceDirectory);
    } catch {
      stats = null;
    }
    if (!stats?.isDirectory()) {
      throw new Error(
        `No directory exists at ${mediaSourceDirectory}. --media-source-dir must name the local directory that holds the exported media objects.`,
      );
    }
  }

  const directory = await assertBundleDirectoryUsable(exportDir);

  const database = openDatabaseImpl(sourceDatabasePath);
  let bundle;
  try {
    bundle = await buildDemoStoreSeedBundle({ database, mediaSourceDirectory });
  } finally {
    database.close();
  }

  const written = await writeBundle(directory, bundle);

  return {
    mode: "export",
    writesEnabled: false,
    network: "none",
    source: { path: sourceDatabasePath, readOnly: true },
    schema: bundle.bundleManifest.schema,
    directory: written.directory,
    files: written.files,
    tables: bundle.bundleManifest.tables,
    rowTotal: bundle.bundleManifest.rowTotal,
    demoStoreContract: bundle.bundleManifest.demoStoreContract,
    media: { ...bundle.bundleManifest.media, objectsCopied: written.mediaObjects.length },
    artifacts: bundle.bundleManifest.artifacts,
  };
}

export function formatDemoStoreExport(summary) {
  const media = summary.media.bytesIncluded
    ? `${summary.media.count} assets · ${summary.media.objectsCopied} objects copied · ${summary.media.totalBytes} bytes`
    : `${summary.media.count} assets · manifest only (no --media-source-dir)`;
  return [
    `Demo-store seed bundle written to ${summary.directory}`,
    `Schema revision: ${formatSchemaRevision(summary.schema)} (source_sha256 ${summary.schema.sourceSha256})`,
    `Source: ${summary.source.path} (read-only)`,
    `Writes: disabled · Network: none`,
    `Catalog: ${summary.rowTotal} rows across ${summary.tables.length} tables`,
    `Media: ${media}`,
    `Demo-store contract: ${summary.demoStoreContract.matches ? "matched" : "not matched"} `
    + `(${summary.demoStoreContract.observed.categories} categories · ${summary.demoStoreContract.observed.products} products · `
    + `${summary.demoStoreContract.observed.skus} SKUs · ${summary.demoStoreContract.observed.collections} collections)`,
    `seed.sql: ${summary.artifacts.seedSql.bytes} bytes · sha256 ${summary.artifacts.seedSql.sha256}`,
    `media-manifest.json: ${summary.artifacts.mediaManifest.bytes} bytes · sha256 ${summary.artifacts.mediaManifest.sha256}`,
  ].join("\n");
}
