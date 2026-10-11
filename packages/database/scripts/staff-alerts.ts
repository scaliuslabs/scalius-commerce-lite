import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSqliteDdlForPostgres } from "./postgres-schema";

export const STAFF_ALERTS_MIGRATION = "0142_staff_alerts";
const BREAKPOINT = "--> statement-breakpoint";

/** Drizzle owns the DDL, journal and snapshot. No history backfill or triggers. */
export function renderStaffAlertsMigration(ddl: readonly string[]) {
  const payload = `${ddl.join(`\n${BREAKPOINT}\n`)}\n`;
  const digest = createHash("sha256").update(payload).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (142, '${STAFF_ALERTS_MIGRATION}', '${digest}');`;
  // PostgreSQL resolves FK targets during CREATE TABLE, unlike SQLite.
  const header = ddl.filter((statement) => /^CREATE TABLE [`"]staff_alerts[`"] /i.test(statement));
  const postgresDdl = [...header, ...ddl.filter((statement) => !header.includes(statement))];
  return { digest, sqlite: `${payload}${BREAKPOINT}\n${ledger}\n`,
    postgres: [...postgresDdl.map(compileSqliteDdlForPostgres), ledger].join(`\n${BREAKPOINT}\n`) + "\n" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${STAFF_ALERTS_MIGRATION}.sql`, import.meta.url);
  const ddl = readFileSync(path, "utf8").split(BREAKPOINT).map((s) => s.trim())
    .filter((s) => /^CREATE (?:TABLE|(?:UNIQUE )?INDEX) /i.test(s));
  if (ddl.filter((s) => /^CREATE TABLE /i.test(s)).length !== 3) throw new Error("Expected three Drizzle staff alert tables.");
  const result = renderStaffAlertsMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${STAFF_ALERTS_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(/version: 141,\n {2}name: "0141_conversation_inbox_counts"/, `version: 142,\n  name: "${STAFF_ALERTS_MIGRATION}"`);
  const entry = `  {\n    version: 142,\n    name: "${STAFF_ALERTS_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  contract = contract.includes('version: 142,\n    name:') ? contract.replace(/ {2}\{\n {4}version: 142,[\s\S]*?\n {2}\},\n/, entry) : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${STAFF_ALERTS_MIGRATION}: ${ddl.length + 1} statements, digest ${result.digest}\n`);
}
