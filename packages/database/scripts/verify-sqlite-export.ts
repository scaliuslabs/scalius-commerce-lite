import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createSqlitePortabilityManifest,
  createTursoPortabilityExecutor,
  listSqlitePortableSchemaObjects,
  verifySqlitePortabilityManifests,
  type SqlitePortabilityExecutor,
} from "../src/portability";
import {
  createProviderSchemaDatabase,
  dropTriggers,
  loadSqliteSqlFile,
  readFinalTriggerDefinitions,
  restoreTriggers,
} from "./sqlite-provider-schema";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseArguments(argv: readonly string[]): {
  sourceExport: string;
  sqliteBinary: string;
} {
  let sourceExport: string | undefined;
  let sqliteBinary = process.env.SQLITE3_BIN?.trim() || "sqlite3";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--source-export") sourceExport = argv[++index];
    else if (argument === "--sqlite-binary") sqliteBinary = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${JSON.stringify(argument)}.`);
  }
  if (!sourceExport?.trim()) throw new Error("--source-export is required.");
  if (!sqliteBinary.trim()) throw new Error("--sqlite-binary must not be empty.");
  return { sourceExport: resolve(sourceExport), sqliteBinary };
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
  const { sourceExport, sqliteBinary } = parseArguments(process.argv.slice(2));
  const databaseUrl = requiredEnvironment("TURSO_DATABASE_URL");
  const authToken = requiredEnvironment("TURSO_AUTH_TOKEN");
  const expectedName = requiredEnvironment("SCALIUS_TEST_DATABASE_NAME");
  assertDisposableTarget(databaseUrl, expectedName);

  const workingDirectory = await mkdtemp(join(tmpdir(), "scalius-portability-verify-"));
  const sourceDatabasePath = join(workingDirectory, "source.sqlite3");
  let sourceDatabase: DatabaseSync | undefined;
  let targetExecutor: SqlitePortabilityExecutor | undefined;
  try {
    sourceDatabase = await createProviderSchemaDatabase("d1", sourceDatabasePath);
    await chmod(sourceDatabasePath, 0o600);
    sourceDatabase.exec("PRAGMA foreign_keys=ON;");
    const sourceTriggers = readFinalTriggerDefinitions(sourceDatabase);
    sourceDatabase.exec("PRAGMA foreign_keys=OFF;");
    dropTriggers(sourceDatabase, sourceTriggers);
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
    sourceDatabase.close();
    sourceDatabase = undefined;

    await loadSqliteSqlFile(sqliteBinary, sourceDatabasePath, sourceExport);
    sourceDatabase = new DatabaseSync(sourceDatabasePath);
    restoreTriggers(sourceDatabase, sourceTriggers);
    sourceDatabase.exec("PRAGMA foreign_keys=ON;");
    const sourceForeignKeyViolations = sourceDatabase
      .prepare("PRAGMA foreign_key_check")
      .all();
    if (sourceForeignKeyViolations.length > 0) {
      throw new Error("Source export reconstruction contains foreign-key violations.");
    }

    targetExecutor = createTursoPortabilityExecutor({
      url: databaseUrl,
      authToken,
    });
    const sourceExecutor = createNodeSqliteExecutor(sourceDatabase);
    const [source, target] = await Promise.all([
      createSqlitePortabilityManifest(sourceExecutor),
      createSqlitePortabilityManifest(targetExecutor),
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
    await targetExecutor?.close?.();
    sourceDatabase?.close();
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

await main();
