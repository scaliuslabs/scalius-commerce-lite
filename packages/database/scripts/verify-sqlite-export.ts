import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  createSqlitePortabilityManifest,
  createTursoPortabilityExecutor,
  listSqlitePortableSchemaObjects,
  verifySqlitePortabilityManifests,
  type SqlitePortabilityExecutor,
} from "../src/portability";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = resolve(scriptDirectory, "../migrations");

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArguments(argv: readonly string[]): { sourceExport: string } {
  let sourceExport: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--source-export") sourceExport = argv[++index];
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!sourceExport?.trim()) throw new Error("--source-export is required.");
  return { sourceExport: resolve(sourceExport) };
}

function assertDisposableTarget(databaseUrl: string, expectedName: string): void {
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  const normalizedName = expectedName.trim().toLowerCase();
  if (
    !normalizedName.startsWith("scalius-") ||
    !normalizedName.includes("test") ||
    !hostname.startsWith(`${normalizedName}-`)
  ) {
    throw new Error("Refusing portability verification against a non-test Turso database.");
  }
}

function createNodeSqliteExecutor(database: DatabaseSync): SqlitePortabilityExecutor {
  return {
    async query(sql, params = []) {
      const normalizedParams = params.map((value) =>
        typeof value === "boolean" ? Number(value) : value,
      );
      return database.prepare(sql).all(...normalizedParams) as Record<string, unknown>[];
    },
  };
}

async function main(): Promise<void> {
  const { sourceExport } = parseArguments(process.argv.slice(2));
  const databaseUrl = requiredEnvironment("TURSO_DATABASE_URL");
  const authToken = requiredEnvironment("TURSO_AUTH_TOKEN");
  const expectedName = requiredEnvironment("SCALIUS_TEST_DATABASE_NAME");
  assertDisposableTarget(databaseUrl, expectedName);

  const sourceDatabase = new DatabaseSync(":memory:");
  sourceDatabase.exec("PRAGMA foreign_keys=ON;");
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));
  for (const name of migrationNames) {
    sourceDatabase.exec(await readFile(join(migrationDirectory, name), "utf8"));
  }
  sourceDatabase.exec("PRAGMA foreign_keys=OFF;");
  const applicationTables = sourceDatabase.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  for (const { name } of applicationTables) {
    if (/_fts(?:_|$)/i.test(name)) continue;
    sourceDatabase.exec(`DELETE FROM "${name.replaceAll('"', '""')}";`);
  }
  sourceDatabase.exec(await readFile(sourceExport, "utf8"));
  sourceDatabase.exec("PRAGMA foreign_keys=ON;");
  const sourceForeignKeyViolations = sourceDatabase
    .prepare("PRAGMA foreign_key_check")
    .all();
  if (sourceForeignKeyViolations.length > 0) {
    throw new Error("Source export reconstruction contains foreign-key violations.");
  }

  const targetExecutor = createTursoPortabilityExecutor({
    url: databaseUrl,
    authToken,
  });
  try {
    const sourceExecutor = createNodeSqliteExecutor(sourceDatabase);
    const [source, target] = await Promise.all([
      createSqlitePortabilityManifest(sourceExecutor, {
        chunkSize: 25,
      }),
      createSqlitePortabilityManifest(targetExecutor, { chunkSize: 25 }),
    ]);
    const verification = verifySqlitePortabilityManifests(source, target);
    let schemaIssues: string[] = [];
    if (source.schemaDigest !== target.schemaDigest) {
      const [sourceSchema, targetSchema] = await Promise.all([
        listSqlitePortableSchemaObjects(sourceExecutor),
        listSqlitePortableSchemaObjects(targetExecutor),
      ]);
      const sourceSchemaByKey = new Map(sourceSchema.map((object) => [
        `${object.type}:${object.name}`,
        object,
      ]));
      const targetSchemaByKey = new Map(targetSchema.map((object) => [
        `${object.type}:${object.name}`,
        object,
      ]));
      schemaIssues = [...new Set([
        ...sourceSchemaByKey.keys(),
        ...targetSchemaByKey.keys(),
      ])]
        .sort()
        .filter((key) =>
          sourceSchemaByKey.get(key)?.sql !== targetSchemaByKey.get(key)?.sql,
        );
    }
    const sourceRows = source.tables.reduce((total, table) => total + table.rowCount, 0);
    const targetRows = target.tables.reduce((total, table) => total + table.rowCount, 0);
    process.stdout.write(`${JSON.stringify({
      ok: verification.ok,
      issues: verification.issues,
      schemaIssues,
      sourceFingerprint: source.fingerprint,
      targetFingerprint: target.fingerprint,
      tableCount: source.tables.length,
      sourceRows,
      targetRows,
    })}\n`);
    if (!verification.ok) process.exitCode = 1;
  } finally {
    await targetExecutor.close?.();
    sourceDatabase.close();
  }
}

await main();
