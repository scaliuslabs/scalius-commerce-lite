/**
 * Canonical schema revision, derived from the migration files themselves.
 *
 * A seed bundle is only loadable into a database at the exact revision it was
 * taken from, so the exporter has to know that revision without trusting the
 * source database. It reads the highest-numbered file in
 * `packages/database/migrations/` and parses the `scalius_schema_migrations`
 * insert that every migration from 0050 onward appends to itself. That insert
 * is the same authority the source's own ledger row carries, so comparing the
 * two compares like with like and there is no second copy of the revision to
 * drift out of date.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SCHEMA_LEDGER_TABLE } from "./tables.mjs";

export const CANONICAL_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../packages/database/migrations/", import.meta.url),
);

const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const RELEASE_LEDGER_INSERT_PATTERN = new RegExp(
  `INSERT\\s+INTO\\s+[\`"]?${SCHEMA_LEDGER_TABLE}[\`"]?\\s*\\([^)]*\\)\\s*VALUES\\s*\\(`
  + "\\s*(\\d+)\\s*,\\s*'([^']+)'\\s*,\\s*'([a-f0-9]{64})'\\s*\\)",
  "iu",
);

/**
 * Reads `{ version, name, sourceSha256 }` for the newest canonical migration.
 * Fails closed when the directory holds no migration, when the newest migration
 * records no release-ledger row, or when that row disagrees with the file name
 * it was written by.
 */
export function readCanonicalSchemaRevision({
  migrationsDirectory = CANONICAL_MIGRATIONS_DIRECTORY,
  readDirImpl = readdirSync,
  readFileImpl = readFileSync,
} = {}) {
  const files = readDirImpl(migrationsDirectory)
    .filter((candidate) => MIGRATION_FILE_PATTERN.test(candidate))
    .sort();
  const newest = files.at(-1);
  if (!newest) {
    throw new Error(
      `No canonical migration files were found in ${migrationsDirectory}; the demo-store export cannot determine the schema revision it would be exporting.`,
    );
  }
  const [, prefix, name] = MIGRATION_FILE_PATTERN.exec(newest);
  const matched = RELEASE_LEDGER_INSERT_PATTERN.exec(readFileImpl(`${migrationsDirectory}${newest}`, "utf8"));
  if (!matched) {
    throw new Error(
      `Canonical migration ${newest} records no ${SCHEMA_LEDGER_TABLE} row, so the demo-store export cannot prove which revision a seed bundle would belong to.`,
    );
  }
  const revision = {
    version: Number(matched[1]),
    name: matched[2],
    sourceSha256: matched[3],
  };
  if (revision.version !== Number(prefix) || revision.name !== `${prefix}_${name}`) {
    throw new Error(
      `Canonical migration ${newest} records release ledger identity ${revision.version}/${revision.name}, which does not match its own file name.`,
    );
  }
  return Object.freeze(revision);
}

export function formatSchemaRevision(revision) {
  return `${revision.version}/${revision.name}`;
}
