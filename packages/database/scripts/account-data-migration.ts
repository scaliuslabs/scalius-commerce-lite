// Renders migration 0225 (what a buyer's account reads) around the DDL Drizzle
// Kit generated for it: its header, the translations table rebuilt for the
// `conversation_topic` resource (with its cache dependency triggers, which
// go with the old table), the triggers of @scalius/database/buyer-account and
// their backfill, the PostgreSQL twin, the ledger row and the schema
// contract's entry.
//
//   pnpm db:generate            (Drizzle writes the DDL, journal and snapshot)
//   pnpm exec tsx packages/database/scripts/account-data-migration.ts --write
//
// Running it again on a rendered file renders the same file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUYER_ACCOUNT_BACKFILL, generateAccountOrderTotalsTriggers, generateConversationBuyerAccountTriggers } from "../src/buyer-account";
import { TRANSLATION_RESOURCE_TYPES } from "../src/schema/translations";
import { cacheDepTriggersForMigration } from "./cache-dep-triggers";
import { collatePostgresTextColumns, compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const ACCOUNT_DATA_VERSION = 225;
export const ACCOUNT_DATA_MIGRATION = `${String(ACCOUNT_DATA_VERSION).padStart(4, "0")}_account_data`;
const BREAKPOINT = "--> statement-breakpoint";

const HEADER = `-- What a buyer's account reads, at any order count (rules/orders/account-summary-reads-maintained-totals.md):
-- - \`account_order_totals\`: per account and currency, the live orders the
--   account owns that are not unfinished checkouts, and what the store holds
--   of them (paid, net of refunds, less disputes lost). Four triggers on
--   orders recompute the (account, currency) rows a write moves an order in
--   or out of; existing orders are counted here.
-- - \`conversations.buyer_account_id\`: the account that reads a thread on the
--   storefront (a store thread's customer, an order thread's order owner
--   while the order is live), kept by three triggers and filled here, with
--   its index. \`conversations.topic\`: the merchant topic a buyer chose.
-- - \`customers.whatsapp\`: the buyer's WhatsApp number when not the phone.
-- - \`translations\` is rebuilt to take the \`conversation_topic\` resource
--   (SQLite cannot widen a CHECK); its indexes and cache dependency
--   triggers are recreated exactly as generated. Every row is kept.`;

/** Drizzle's statements in the file it wrote, without breakpoints, comments or PRAGMAs. */
function drizzleStatements(migration: string): string[] {
  return migration.split(BREAKPOINT)
    .map((statement) => statement.replace(/^(?:--[^\n]*\n)+/, "").trim())
    .filter((statement) => statement && !/^PRAGMA /i.test(statement) && !/^(?:CREATE|DROP) TRIGGER /i.test(statement)
      && !/^INSERT INTO scalius_schema_migrations/i.test(statement) && !/^(?:INSERT INTO account_order_totals|UPDATE conversations)/.test(statement));
}

// Drizzle Kit renders the expression column of the identity index as two
// quoted names; 0121 wrote it as an expression.
const IDENTITY_INDEX = "CREATE UNIQUE INDEX `translations_identity_unique` ON `translations` (`resource_type`,`resource_id`,`locale`,coalesce(\"market_id\", ''));";

/**
 * The triggers of other tables that name `translations` (a deleted resource's
 * translations go with it, 0121): SQLite re-reads them when the rebuilt table
 * is renamed, so they are dropped before the rebuild and recreated as 0121
 * wrote them after it.
 */
function translationCleanupTriggers(): { name: string; sqlite: string }[] {
  const source = readFileSync(new URL("../migrations/0121_translations.sql", import.meta.url), "utf8");
  return source.split(BREAKPOINT)
    .map((statement) => statement.replace(/^\s*(?:--[^\n]*\n)+/, "").trim())
    .flatMap((statement) => {
      const name = /^CREATE TRIGGER `([a-z_]+_translations_cleanup)`/.exec(statement)?.[1];
      return name ? [{ name, sqlite: statement.replace(/;$/, "") + ";" }] : [];
    });
}

export function renderAccountDataMigration(ddl: readonly string[]) {
  const cleanup = translationCleanupTriggers();
  if (cleanup.length !== 10) throw new Error(`Expected the 10 translation cleanup triggers of 0121, found ${cleanup.length}.`);
  const statements = ddl.flatMap((statement) => {
    if (statement.startsWith("CREATE UNIQUE INDEX `translations_identity_unique`")) return [IDENTITY_INDEX];
    const ended = statement.replace(/;$/, "") + ";";
    if (statement.startsWith("CREATE TABLE `__new_translations`")) return [...cleanup.map((trigger) => `DROP TRIGGER \`${trigger.name}\`;`), ended];
    if (statement.startsWith("CREATE INDEX `translations_market_idx`")) return [ended, ...cleanup.map((trigger) => trigger.sqlite)];
    return [ended];
  });
  const totals = generateAccountOrderTotalsTriggers();
  const threads = generateConversationBuyerAccountTriggers();
  const cdep = cacheDepTriggersForMigration(ACCOUNT_DATA_MIGRATION);
  const body = [
    ...statements,
    ...totals.map((trigger) => `${trigger.sqlite};`),
    ...threads.map((trigger) => `${trigger.sqlite};`),
    ...BUYER_ACCOUNT_BACKFILL.map((statement) => `${statement};`),
    ...cdep.map((trigger) => `${trigger.sqlite};`),
  ];
  body[0] = `${HEADER}\n${body[0]}`;
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (${ACCOUNT_DATA_VERSION}, '${ACCOUNT_DATA_MIGRATION}', '${digest}');`;
  const quoted = TRANSLATION_RESOURCE_TYPES.map((type) => `'${type}'`).join(", ");
  // PostgreSQL widens the CHECK in place: the table, its indexes and triggers stay.
  const rebuild = (statement: string) => /^(?:CREATE TABLE `__new_translations`|INSERT INTO `__new_translations`|DROP TABLE `translations`|ALTER TABLE `__new_translations`|DROP TRIGGER |CREATE TRIGGER )|`translations` \(/.test(statement);
  const postgresDdl = statements.filter((statement) => !rebuild(statement)).map((statement) => collatePostgresTextColumns(compileSqliteDdlForPostgres(statement))
      // Every PostgreSQL text column is COLLATE "C" (0151), an added one too.
      .replace(/^ALTER TABLE ("[a-z_]+") ADD ("[a-z_]+") text;$/, 'ALTER TABLE $1 ADD COLUMN $2 text COLLATE "C";'));
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      `-- What a buyer's account reads: see ../${ACCOUNT_DATA_MIGRATION}.sql.\n${postgresDdl[0]}`,
      ...postgresDdl.slice(1),
      `ALTER TABLE "translations" DROP CONSTRAINT "translations_resource_type_check";`,
      `ALTER TABLE "translations" ADD CONSTRAINT "translations_resource_type_check" CHECK("translations"."resource_type" IN (${quoted}));`,
      ...totals.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ...threads.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ...BUYER_ACCOUNT_BACKFILL.map((statement) => `${statement};`),
      // The same cache dependency triggers, reinstalled as every rebuild does (the table itself stays).
      ...cdep.flatMap((trigger) => [`DROP TRIGGER IF EXISTS "${trigger.name}" ON "translations";`, `${trigger.postgres};`]),
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
