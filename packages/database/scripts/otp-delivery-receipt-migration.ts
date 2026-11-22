// Renders migration 0223 around the DDL Drizzle Kit generated for it (the
// expiry index): its header, the status guard of `auth_otp_delivery_receipts`
// (status-guards.ts: the retired state mapped, then the guard triggers on
// SQLite and a CHECK on PostgreSQL), the expiry of rows that had none, the
// ledger row and the schema contract's entry.
//
//   pnpm db:generate
//   node <tsx> packages/database/scripts/otp-delivery-receipt-migration.ts --write
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { statusGuardMigrationStatements } from "../src/status-guards";
import { drizzleDdlOf } from "./payment-disputes-migration";
import { compileSqliteDdlForPostgres } from "./postgres-schema";

export const OTP_RECEIPT_VERSION = 223;
export const OTP_RECEIPT_MIGRATION = `0${OTP_RECEIPT_VERSION}_otp_delivery_receipt_guard`;
const BREAKPOINT = "--> statement-breakpoint";

/** A receipt written without its code's expiry ends ten minutes after it was made (a code lives five). */
export const OTP_RECEIPT_EXPIRY_BACKFILL = (q: (name: string) => string) =>
  `UPDATE ${q("auth_otp_delivery_receipts")} SET ${q("otp_expires_at")} = ${q("created_at")} + 600 WHERE ${q("otp_expires_at")} IS NULL`;

const HEADER = `-- Sign-in code delivery receipts end and expire
-- (rules/auth/otp-delivery-receipt-ends-and-expires.md): the status refuses
-- any value its code does not declare (two guard triggers that write no row;
-- a CHECK on PostgreSQL), after \`delivered\`, declared but never written, is
-- mapped to \`accepted\`. Every receipt gets its code's expiry (one written
-- without it ends ten minutes after it was made), indexed for the sweep that
-- ends and deletes them. Only rows that need it are written; no table is rebuilt.`;

export function renderOtpReceiptMigration(ddl: readonly string[]) {
  const guards = statusGuardMigrationStatements(OTP_RECEIPT_VERSION);
  const sqliteQ = (name: string) => `\`${name}\``;
  const postgresQ = (name: string) => `"${name}"`;
  const [retired, ...triggers] = guards.sqlite;
  const body = [...ddl, retired!, OTP_RECEIPT_EXPIRY_BACKFILL(sqliteQ), ...triggers].map((statement) => `${statement};`);
  body[0] = `${HEADER}\n${body[0]}`;
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (${OTP_RECEIPT_VERSION}, '${OTP_RECEIPT_MIGRATION}', '${digest}');`;
  const [pgRetired, ...checks] = guards.postgres;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      `-- See ../${OTP_RECEIPT_MIGRATION}.sql.\n${compileSqliteDdlForPostgres(ddl[0]!)};`,
      ...ddl.slice(1).map((statement) => `${compileSqliteDdlForPostgres(statement)};`),
      `${pgRetired};`,
      `${OTP_RECEIPT_EXPIRY_BACKFILL(postgresQ)};`,
      ...checks.map((statement) => `${statement};`),
      ledger,
    ].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${OTP_RECEIPT_MIGRATION}.sql`, import.meta.url);
  if (!existsSync(path)) throw new Error(`Run pnpm db:generate first: ${OTP_RECEIPT_MIGRATION}.sql is missing.`);
  const ddl = drizzleDdlOf(readFileSync(path, "utf8")).map((statement) => statement.replace(/;$/u, ""));
  const result = renderOtpReceiptMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${OTP_RECEIPT_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(
    /export const CURRENT_DATABASE_SCHEMA = \{\n {2}version: \d+,\n {2}name: "[^"]+",/,
    `export const CURRENT_DATABASE_SCHEMA = {\n  version: ${OTP_RECEIPT_VERSION},\n  name: "${OTP_RECEIPT_MIGRATION}",`,
  );
  const entry = `  {\n    version: ${OTP_RECEIPT_VERSION},\n    name: "${OTP_RECEIPT_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  const existing = new RegExp(` {2}\\{\\n {4}version: ${OTP_RECEIPT_VERSION},[\\s\\S]*?\\n {2}\\},\\n`);
  contract = existing.test(contract) ? contract.replace(existing, entry) : contract.replace(/\] as const;\n\nexport interface DatabaseSchemaState/, `${entry}] as const;\n\nexport interface DatabaseSchemaState`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${OTP_RECEIPT_MIGRATION}: ${ddl.length} DDL statements, digest ${result.digest}\n`);
}
