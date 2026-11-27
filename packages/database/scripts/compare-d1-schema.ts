/**
 * Read-only: compares a live D1 database's schema with the one this tree's
 * migration chain builds, before a first guarded upgrade. Feed it the JSON of
 *
 *   wrangler d1 execute <db> --remote --json --command "SELECT type, name, tbl_name, sql
 *     FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'"
 *
 *   pnpm --dir apps/api exec tsx ../../packages/database/scripts/compare-d1-schema.ts --remote <absolute file> [--through 0226_order_line_messages]
 *
 * `--through` is the store's last applied migration (default: this tree's
 * last). Exits 1 and names every table, index, trigger and view that is
 * missing, extra or different.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createReleaseSchema, migrationFiles } from "../src/testing/release-image";

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name?: string;
  sql: string | null;
}

const normalized = (sql: string | null) => (sql ?? "").replace(/\s+/g, " ").trim();

/** Every difference between two schemas, one line each; empty when they match. */
export function compareSchemaRows(expected: readonly SchemaRow[], actual: readonly SchemaRow[]): string[] {
  const key = (row: SchemaRow) => `${row.type} ${row.name}`;
  const local = new Map(expected.map((row) => [key(row), row]));
  const remote = new Map(actual.map((row) => [key(row), row]));
  const differences: string[] = [];
  for (const [name, row] of local) {
    const live = remote.get(name);
    if (!live) differences.push(`missing on the store: ${name}`);
    else if (normalized(live.sql) !== normalized(row.sql)) differences.push(`different on the store: ${name}`);
  }
  for (const name of remote.keys()) if (!local.has(name)) differences.push(`extra on the store: ${name}`);
  return differences.sort();
}

/** The rows of `wrangler d1 execute --json`. */
export function parseRemoteSchema(text: string): SchemaRow[] {
  const parsed = JSON.parse(text) as Array<{ results?: SchemaRow[] }>;
  const rows = parsed?.[0]?.results;
  if (!Array.isArray(rows)) throw new Error("Not the JSON of one wrangler d1 execute --json answer.");
  return rows;
}

function localSchema(through: string): SchemaRow[] {
  const sqlite = createReleaseSchema(through);
  try {
    return sqlite.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all() as unknown as SchemaRow[];
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const remoteFile = value("--remote");
  if (!remoteFile) {
    console.error("Pass --remote <file> (the JSON of the wrangler d1 execute command in this file's header).");
    process.exit(1);
  }
  const through = value("--through") ?? migrationFiles().at(-1)!.replace(/\.sql$/, "");
  const differences = compareSchemaRows(localSchema(through), parseRemoteSchema(readFileSync(resolve(remoteFile), "utf8")));
  if (differences.length > 0) {
    console.error(`The store's schema differs from the chain through ${through}:`);
    for (const line of differences) console.error(`- ${line}`);
    process.exit(1);
  }
  console.log(`The store's schema equals the chain through ${through}.`);
}
