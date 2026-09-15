/**
 * Print the D1 migration plan (`scalius-d1-migration-plan/v1`) for the
 * canonical migration chain in `migrations/*.sql` as JSON.
 *
 *   pnpm --filter @scalius/database migration-plan            # stdout
 *   pnpm --filter @scalius/database migration-plan --out plan.json
 *
 * Only the top-level SQLite/D1 chain is included; `migrations/postgres/` and
 * `migrations/meta/` are never part of the D1 contract. The command fails
 * closed when the chain does not end at `CURRENT_DATABASE_SCHEMA`.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertD1MigrationPlanCurrent,
  buildD1MigrationPlan,
  type D1MigrationFile,
  type D1MigrationPlan,
} from "../src/migration-plan";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(scriptDirectory, "../migrations");

function parseArguments(argv: readonly string[]): { outputPath: string | null } {
  let outputPath: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--out") {
      const value = argv[++index];
      if (!value?.trim()) throw new Error("--out requires a file path.");
      outputPath = resolve(value);
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
    }
  }
  return { outputPath };
}

export async function readCanonicalMigrationFiles(
  directory = migrationDirectory,
): Promise<readonly D1MigrationFile[]> {
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(join(directory, name), "utf8"),
  })));
}

export async function loadCanonicalD1MigrationPlan(
  directory = migrationDirectory,
): Promise<D1MigrationPlan> {
  const plan = await buildD1MigrationPlan(await readCanonicalMigrationFiles(directory));
  assertD1MigrationPlanCurrent(plan);
  return plan;
}

async function main(): Promise<void> {
  const { outputPath } = parseArguments(process.argv.slice(2));
  const plan = await loadCanonicalD1MigrationPlan();
  const json = `${JSON.stringify(plan, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, json, "utf8");
    process.stdout.write(`${JSON.stringify({
      contract: plan.contract,
      migrationCount: plan.migrations.length,
      expectedSchema: plan.expectedSchema,
      outputPath,
    })}\n`);
    return;
  }
  process.stdout.write(json);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
