import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const databaseRoot = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseRoot, "migrations");
const metaDir = join(migrationsDir, "meta");

// Trigger-only migrations do not alter Drizzle's table/index model and
// therefore have no meaningful schema snapshot to generate.
const allowedMissingSnapshots = new Set(["0049"]);

const sqlFiles = readdirSync(migrationsDir)
  .filter((file) => /^\d{4}_.+\.sql$/.test(file))
  .sort();
const snapshots = readdirSync(metaDir)
  .filter((file) => /^\d{4}_snapshot\.json$/.test(file))
  .sort();
const journal = JSON.parse(
  readFileSync(join(metaDir, "_journal.json"), "utf8"),
);

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

if (errors.length > 0) {
  console.error("Migration metadata check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Migration metadata OK: ${sqlFiles.length} SQL files, ${journalEntries.length} journal entries, ${snapshots.length} snapshots, ${allowedMissingSnapshots.size} allowed manual snapshot gaps.`,
);
