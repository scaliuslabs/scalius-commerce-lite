// Renders migration 0225 (what a buyer's account reads) around the DDL Drizzle
// Kit generated for it: its header, the triggers of
// @scalius/database/buyer-account and their backfill, the PostgreSQL twin,
// the ledger row and the schema contract's entry. It only adds: no table is
// rebuilt.
//
//   pnpm db:generate            (Drizzle writes the DDL, journal and snapshot)
//   pnpm exec tsx packages/database/scripts/account-data-migration.ts --write
//
// Running it again on a rendered file renders the same file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUYER_ACCOUNT_BACKFILL, generateAccountOrderTotalsTriggers, generateConversationBuyerAccountTriggers } from "../src/buyer-account";
import { collatePostgresTextColumns, compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const ACCOUNT_DATA_VERSION = 225;
export const ACCOUNT_DATA_MIGRATION = `${String(ACCOUNT_DATA_VERSION).padStart(4, "0")}_account_data`;
const BREAKPOINT = "--> statement-breakpoint";

const HEADER = `-- What a buyer's account reads, at any order count (rules/orders/account-summary-reads-maintained-totals.md).
-- Additive: no table is rebuilt.
-- - \`account_order_totals\`: per account and currency, the live orders the
--   account owns that are not unfinished checkouts, and what the store holds
--   of them (paid, net of refunds, less disputes lost). Four triggers on
--   orders recompute the (account, currency) row a write moves a counted
--   order into or out of. The backfill writes one row per (account, currency)
--   with a counted order; an owner id with no customer row is skipped.
-- - The owner index of orders gains the currency: a refresh reads one
--   currency's orders of one account. Rebuilding it writes one entry per
--   order that has an owner.
-- - \`conversations.buyer_account_id\`: the account that reads a thread on the
--   storefront (a store thread's customer, an order thread's order owner
--   while the order is live), kept by three triggers. The backfill writes one
--   row per storefront store thread and one per order-scoped thread. Its
--   index, and \`conversations.topic\`: the merchant topic a buyer chose.
-- - \`customers.whatsapp\`: the buyer's WhatsApp number when not the phone.
-- - \`customers.sign_in_recovery\` / \`sign_in_recovery_at\`: the one recovery
--   contact a sign-in reset named; for 7 days, and only while the account
--   proves nothing, a sign-in code to it reaches the account. Partial indexes
--   on the marked phone and email.`;

/** Drizzle's statements in the file it wrote, without breakpoints, comments, triggers, backfills or the ledger row. */
function drizzleStatements(migration: string): string[] {
  return migration.split(BREAKPOINT)
    .map((statement) => statement.replace(/^(?:--[^\n]*\n)+/, "").trim())
    .filter((statement) => statement && !/^PRAGMA /i.test(statement) && !/^(?:CREATE|DROP) TRIGGER /i.test(statement)
      && !/^INSERT INTO scalius_schema_migrations/i.test(statement) && !/^(?:INSERT INTO account_order_totals|UPDATE conversations)/.test(statement));
}

export function renderAccountDataMigration(ddl: readonly string[]) {
  const statements = ddl.map((statement) => statement.replace(/;$/, "") + ";");
  const totals = generateAccountOrderTotalsTriggers();
  const threads = generateConversationBuyerAccountTriggers();
  const body = [
    ...statements,
    ...totals.map((trigger) => `${trigger.sqlite};`),
    ...threads.map((trigger) => `${trigger.sqlite};`),
    ...BUYER_ACCOUNT_BACKFILL.map((statement) => `${statement};`),
  ];
  body[0] = `${HEADER}\n${body[0]}`;
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (${ACCOUNT_DATA_VERSION}, '${ACCOUNT_DATA_MIGRATION}', '${digest}');`;
  const postgresDdl = statements.map((statement) => collatePostgresTextColumns(compileSqliteDdlForPostgres(statement))
    // Every PostgreSQL text column is COLLATE "C" (0151), an added one too.
    .replace(/^ALTER TABLE ("[a-z_]+") ADD ("[a-z_]+") text;$/, 'ALTER TABLE $1 ADD COLUMN $2 text COLLATE "C";'));
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      `-- What a buyer's account reads: see ../${ACCOUNT_DATA_MIGRATION}.sql.\n${postgresDdl[0]}`,
      ...postgresDdl.slice(1),
      ...totals.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ...threads.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ...BUYER_ACCOUNT_BACKFILL.map((statement) => `${statement};`),
      ledger,
    ].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${ACCOUNT_DATA_MIGRATION}.sql`, import.meta.url);
  if (!existsSync(path)) throw new Error(`Run pnpm db:generate first and name its file ${ACCOUNT_DATA_MIGRATION}.sql.`);
  const ddl = drizzleStatements(readFileSync(path, "utf8").replace(/^(?:--[^\n]*\n)+/, ""));
  const result = renderAccountDataMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${ACCOUNT_DATA_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(
    /export const CURRENT_DATABASE_SCHEMA = \{\n {2}version: \d+,\n {2}name: "[^"]+",/,
    `export const CURRENT_DATABASE_SCHEMA = {\n  version: ${ACCOUNT_DATA_VERSION},\n  name: "${ACCOUNT_DATA_MIGRATION}",`,
  );
  const entry = `  {\n    version: ${ACCOUNT_DATA_VERSION},\n    name: "${ACCOUNT_DATA_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  const existing = new RegExp(` {2}\\{\\n {4}version: ${ACCOUNT_DATA_VERSION},[\\s\\S]*?\\n {2}\\},\\n`);
  contract = existing.test(contract) ? contract.replace(existing, entry) : contract.replace(/\] as const;\n\nexport interface DatabaseSchemaState/, `${entry}] as const;\n\nexport interface DatabaseSchemaState`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${ACCOUNT_DATA_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
