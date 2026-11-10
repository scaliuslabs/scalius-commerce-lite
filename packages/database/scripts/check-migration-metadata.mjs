import { readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const databaseRoot = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseRoot, "migrations");
const metaDir = join(migrationsDir, "meta");
const postgresMigrationsDir = join(migrationsDir, "postgres");
const firstProviderNeutralMigration = 50;

// Drizzle Kit diffs the schema against the newest snapshot only, so meta/
// keeps just that one (`pnpm db:generate` runs `--prune` to remove the older
// ones after Drizzle Kit writes a new one; history keeps them). Several
// snapshots appear only after a merge: they must chain, so two branches that
// each generated a migration from the same parent fail here, and the later
// one is rebased and regenerated instead of pruned.
//
// Hand-written migrations own trigger changes and coordinated table rebuilds;
// one newer than the newest snapshot is listed here (an id at or below the
// newest snapshot no longer needs listing). Their exact ledger identity and
// provider sidecars are checked below; the migration chain remains the
// canonical schema.
const allowedMissingSnapshots = new Set(["0049", "0059", "0065", "0066", "0068", "0070", "0071", "0072", "0075", "0077", "0078", "0080", "0081", "0082", "0083", "0084", "0085", "0086", "0087", "0088", "0089", "0090", "0091", "0092", "0093", "0094", "0099", "0100", "0115", "0149", "0151", "0152", "0153", "0154", "0157", "0164", "0166", "0167", "0176", "0180", "0181", "0182", "0183", "0184", "0185", "0186", "0187", "0190", "0191", "0195", "0203", "0205", "0206", "0207", "0217"]);

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

const newestSnapshot = snapshots.at(-1)?.slice(0, 4) ?? null;
if (newestSnapshot === null) errors.push("meta/ has no Drizzle snapshot; drizzle-kit generate needs the newest one");
const chained = errors.length === 0;

for (const id of sqlById.keys()) {
  if (snapshotIds.has(id) || (newestSnapshot !== null && id <= newestSnapshot)) continue;
  if (!allowedMissingSnapshots.has(id)) {
    errors.push(
      `${id} is newer than the newest Drizzle snapshot and is not in the manual-migration allowlist`,
    );
  }
}

const olderSnapshots = snapshots.slice(0, -1);
if (process.argv.includes("--prune")) {
  if (!chained) {
    console.error("Not pruning: fix the snapshot chain first (pruning would hide the break).");
  } else {
    for (const file of olderSnapshots) rmSync(join(metaDir, file));
    if (olderSnapshots.length > 0) console.log(`Pruned ${olderSnapshots.length} older snapshot(s); kept ${snapshots.at(-1)}.`);
    olderSnapshots.length = 0;
  }
}
if (olderSnapshots.length > 0 && chained) {
  // A merged chain is sound; `pnpm db:generate` prunes, and so does --prune.
  console.warn(
    `meta/ needs only the newest snapshot (${snapshots.at(-1)}); remove ${olderSnapshots.length} older one(s) with: ` +
      "node packages/database/scripts/check-migration-metadata.mjs --prune",
  );
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
  `Migration metadata OK: ${sqlFiles.length} SQL files, ${journalEntries.length} journal entries, newest snapshot ${newestSnapshot}, ${upgradeFiles.length} provider-neutral upgrades.`,
);
