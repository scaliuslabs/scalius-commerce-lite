import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const databaseRoot = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseRoot, "migrations");
const metaDir = join(migrationsDir, "meta");
const postgresMigrationsDir = join(migrationsDir, "postgres");
const firstProviderNeutralMigration = 50;

// Trigger-only migrations do not alter Drizzle's table/index model and
// therefore have no meaningful schema snapshot to generate.
const allowedMissingSnapshots = new Set(["0049", "0059"]);

const sqlFiles = readdirSync(migrationsDir)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();
const snapshots = readdirSync(metaDir)
  .filter((file) => /^\d{4}_snapshot\.json$/.test(file))
  .sort();
const journal = JSON.parse(
  readFileSync(join(metaDir, "_journal.json"), "utf8"),
);
const postgresSqlFiles = readdirSync(postgresMigrationsDir)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();

const sqlById = new Map(sqlFiles.map((file) => [file.slice(0, 4), file]));
const snapshotIds = new Set(snapshots.map((file) => file.slice(0, 4)));
const snapshotMetadata = snapshots.map((file) => ({
  file,
  value: JSON.parse(readFileSync(join(metaDir, file), "utf8")),
}));
const journalEntries = Array.isArray(journal.entries) ? journal.entries : [];
const journalById = new Map(
  journalEntries.map((entry) => [String(entry.tag).slice(0, 4), entry]),
);

const errors = [];

const snapshotFileByIdentity = new Map();
for (const { file, value } of snapshotMetadata) {
  const identity = typeof value.id === "string" ? value.id : "";
  if (!identity) {
    errors.push(`${file} has no snapshot id`);
    continue;
  }
  const existingFile = snapshotFileByIdentity.get(identity);
  if (existingFile) {
    errors.push(`${file} duplicates snapshot id ${identity} from ${existingFile}`);
  } else {
    snapshotFileByIdentity.set(identity, file);
  }
}

for (let index = 1; index < snapshotMetadata.length; index += 1) {
  const previous = snapshotMetadata[index - 1];
  const current = snapshotMetadata[index];
  if (current.value.prevId !== previous.value.id) {
    errors.push(
      `${current.file} parent ${String(current.value.prevId)} does not match ` +
        `${previous.file} id ${String(previous.value.id)}`,
    );
  }
}

for (const [id, file] of sqlById) {
  const entry = journalById.get(id);
  if (!entry) {
    errors.push(`${file} is missing from meta/_journal.json`);
    continue;
  }
  if (entry.tag !== file.replace(/\.sql$/, "")) {
    errors.push(`${file} journal tag mismatch: ${entry.tag}`);
  }
}

for (const [id, entry] of journalById) {
  if (!sqlById.has(id)) {
    errors.push(`Journal entry ${entry.tag} has no matching SQL migration`);
  }
}

for (const id of snapshotIds) {
  if (!sqlById.has(id)) {
    errors.push(`${id}_snapshot.json has no matching SQL migration`);
  }
}

for (const id of sqlById.keys()) {
  if (snapshotIds.has(id)) continue;
  if (!allowedMissingSnapshots.has(id)) {
    errors.push(
      `${id} is missing a Drizzle snapshot and is not in the manual-migration allowlist`,
    );
  }
}

for (const id of allowedMissingSnapshots) {
  if (!sqlById.has(id)) {
    errors.push(`Allowlisted missing snapshot ${id} has no matching SQL migration`);
  }
  if (snapshotIds.has(id)) {
    errors.push(`Allowlisted missing snapshot ${id} now has a snapshot; remove it from the allowlist`);
  }
}

const statementBreakpoint = "--> statement-breakpoint";

function splitUpgradeStatements(sql) {
  return sql.split(statementBreakpoint).map((statement) => statement.trim()).filter(Boolean);
}

function sourcePayloadSha256(statements) {
  const payload = `${statements.slice(0, -1).join(`\n${statementBreakpoint}\n`)}\n`;
  return createHash("sha256").update(payload).digest("hex");
}

function containsExactSchemaLedgerInsert(statements, file, sourceSha256) {
  const version = Number(file.slice(0, 4));
  const name = file.replace(/\.sql$/, "");
  const ledgerStatements = statements.filter((statement) =>
    /^INSERT\s+INTO\s+[`"]?scalius_schema_migrations[`"]?\b/i.test(statement),
  );
  if (ledgerStatements.length !== 1 || ledgerStatements[0] !== statements.at(-1)) {
    return false;
  }
  const normalized = ledgerStatements[0]
    .replace(/[`"]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const expected = "INSERT INTO scalius_schema_migrations (version, name, source_sha256) "
    + `VALUES (${version}, '${name}', '${sourceSha256}')`;
  return normalized.replace(/;$/, "") === expected;
}

function unsafeTransactionStatement(statements) {
  return statements.find((statement) => {
    const executable = statement
      .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/g, "")
      .trimStart();
    return /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|ATTACH|DETACH|PRAGMA|ALTER\s+SYSTEM|CREATE\s+DATABASE|DROP\s+DATABASE)\b/i
      .test(executable)
      || /^(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX)\s+CONCURRENTLY\b/i
        .test(executable);
  });
}

const upgradeFiles = sqlFiles.filter((file) =>
  Number(file.slice(0, 4)) >= firstProviderNeutralMigration,
);
for (let index = 0; index < upgradeFiles.length; index += 1) {
  const file = upgradeFiles[index];
  const expectedVersion = firstProviderNeutralMigration + index;
  if (Number(file.slice(0, 4)) !== expectedVersion) {
    errors.push(`Provider-neutral migrations are not contiguous at ${expectedVersion}`);
  }
  if (!postgresSqlFiles.includes(file)) {
    errors.push(`${file} is missing its PostgreSQL sidecar`);
  }
  const source = readFileSync(join(migrationsDir, file), "utf8");
  const sourceStatements = splitUpgradeStatements(source);
  const sourceSha256 = sourcePayloadSha256(sourceStatements);
  if (!containsExactSchemaLedgerInsert(sourceStatements, file, sourceSha256)) {
    errors.push(`${file} does not record its exact schema identity and source digest`);
  }
  if (unsafeTransactionStatement(sourceStatements)) {
    errors.push(`${file} contains a transaction-unsafe statement`);
  }
  if (postgresSqlFiles.includes(file)) {
    const postgres = readFileSync(join(postgresMigrationsDir, file), "utf8");
    const postgresStatements = splitUpgradeStatements(postgres);
    if (!containsExactSchemaLedgerInsert(postgresStatements, file, sourceSha256)) {
      errors.push(`${file} PostgreSQL sidecar does not record its exact identity and source digest`);
    }
    if (unsafeTransactionStatement(postgresStatements)) {
      errors.push(`${file} PostgreSQL sidecar contains a transaction-unsafe statement`);
    }
  }
}

for (const file of postgresSqlFiles) {
  if (!upgradeFiles.includes(file)) {
    errors.push(`PostgreSQL sidecar ${file} has no provider-neutral migration`);
  }
}

if (errors.length > 0) {
  console.error("Migration metadata check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Migration metadata OK: ${sqlFiles.length} SQL files, ${journalEntries.length} journal entries, ${snapshots.length} snapshots, ${upgradeFiles.length} provider-neutral upgrades, ${allowedMissingSnapshots.size} allowed manual snapshot gaps.`,
);
