// Renders migration 0220 (disputes on captured payments) around the DDL
// Drizzle Kit generated for it: its header, the projection's dispute triggers
// (generateAnalyticsDisputeTriggers), the PostgreSQL twin compiled from the
// same statements, the ledger row and the schema contract's entry.
//
//   pnpm db:generate            (Drizzle writes the DDL, journal and snapshot)
//   pnpm exec tsx packages/database/scripts/payment-disputes-migration.ts --write
//
// A later schema change for 0220 (not deployed) is folded in: pnpm db:generate
// writes the change as the next migration, then `--fold --write` moves its
// statements into 0220, its snapshot over 0220's (keeping 0220's id and its
// prevId, the link to the migration before it), drops it from the journal and
// renders 0220 again. Nothing here names another migration's digest: after a
// merge that changes the migration before 0220, pnpm db:generate relinks the
// snapshot and the generator test still holds.
//
// Renumbered: change PAYMENT_DISPUTES_VERSION, rename the Drizzle file to
// match, and run it again; the source digest does not depend on the number.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateAnalyticsDisputeTriggers } from "../src/analytics-rollup";
import { generateCustomerSpendTriggers } from "../src/customer-spend";
import { generateRefundSettledRequeueTrigger } from "../src/dispute-refund-wait";
import { collatePostgresTextColumns, compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const PAYMENT_DISPUTES_VERSION = 220;
export const PAYMENT_DISPUTES_MIGRATION = `${String(PAYMENT_DISPUTES_VERSION).padStart(4, "0")}_payment_disputes`;
const BREAKPOINT = "--> statement-breakpoint";

const HEADER = `-- Disputes (chargebacks) on captured payments: one row per provider dispute,
-- moved only through the dispute state table
-- (packages/core/src/modules/payments/disputes.ts). A dispute counts at most
-- what its payment still held (\`counted_minor\`); while its funds are
-- withdrawn that is the store's loss, \`orders.disputed_minor\`, never a
-- balance the buyer owes, and the analytics projection counts it once as
-- lost revenue (\`analytics_order_facts.dispute_sum\`, its three triggers).
-- A customer's spend is paid less disputed: the four 0123 triggers that keep
-- \`customer_order_stats\` are replaced (same names). No spend is recomputed:
-- \`disputed_minor\` is new here, zero on every order, so every stored spend
-- already equals paid less disputed.
-- A provider's dispute event parked behind a refund on its order is due
-- again the moment one of the order's refund attempts settles
-- (\`refund_attempts_settled_requeue_disputes\`).
-- Additive: every existing row keeps its values (zero disputed).`;

/** Drizzle's own statements in a migration file: a rendered file is read back the same way (its header and triggers dropped). */
export function drizzleDdlOf(migration: string): string[] {
  return migration.split(BREAKPOINT)
    .map((statement) => statement.replace(/^(?:--[^\n]*\n)+/, "").trim())
    .filter((statement) => /^(?:CREATE (?:TABLE|UNIQUE INDEX|INDEX)|ALTER TABLE) /i.test(statement));
}

export function renderPaymentDisputesMigration(ddl: readonly string[]) {
  const triggers = generateAnalyticsDisputeTriggers();
  const spend = generateCustomerSpendTriggers();
  const requeue = generateRefundSettledRequeueTrigger();
  const body = [
    ...ddl,
    ...triggers.map((trigger) => `${trigger.sqlite};`),
    ...spend.flatMap((trigger) => [`DROP TRIGGER IF EXISTS ${trigger.name};`, `${trigger.sqlite};`]),
    `${requeue.sqlite};`,
  ];
  body[0] = `${HEADER}\n${body[0]}`;
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (${PAYMENT_DISPUTES_VERSION}, '${PAYMENT_DISPUTES_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      // Every PostgreSQL text column is COLLATE "C" (0151): one byte order on every provider.
      `-- Disputes (chargebacks) on captured payments: see ../${PAYMENT_DISPUTES_MIGRATION}.sql.\n${collatePostgresTextColumns(compileSqliteDdlForPostgres(ddl[0]!))}`,
      ...ddl.slice(1).map((statement) => collatePostgresTextColumns(compileSqliteDdlForPostgres(statement))),
      ...triggers.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ...spend.flatMap((trigger) => [
        `DROP TRIGGER IF EXISTS ${trigger.name} ON ${trigger.table};`,
        compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite }),
      ]),
      compileSqliteTriggerForPostgres({ name: requeue.name, sql: requeue.sqlite }),
      ledger,
    ].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

/** Moves the migration Drizzle wrote after 0220 into 0220 (see the header); false when there is none. */
function foldNextMigration(): boolean {
  const next = String(PAYMENT_DISPUTES_VERSION + 1).padStart(4, "0");
  const dir = new URL("../migrations/", import.meta.url);
  const file = readdirSync(dir).find((name) => name.startsWith(`${next}_`) && name.endsWith(".sql"));
  if (!file) return false;
  const path = new URL(`${PAYMENT_DISPUTES_MIGRATION}.sql`, dir);
  const parts = readFileSync(path, "utf8").replace(/\n$/, "").split(BREAKPOINT);
  const ledger = parts.pop()!;
  const added = readFileSync(new URL(file, dir), "utf8").split(BREAKPOINT).map((statement) => statement.trim()).filter(Boolean);
  writeFileSync(path, [...parts, ...added.map((statement) => `\n${statement}\n`), ledger].join(BREAKPOINT) + "\n");
  const snapshot = (version: string) => new URL(`meta/${version}_snapshot.json`, dir);
  const own = JSON.parse(readFileSync(snapshot(String(PAYMENT_DISPUTES_VERSION).padStart(4, "0")), "utf8")) as { id: string; prevId: string };
  const folded = JSON.parse(readFileSync(snapshot(next), "utf8")) as { id: string; prevId: string };
  writeFileSync(snapshot(String(PAYMENT_DISPUTES_VERSION).padStart(4, "0")), JSON.stringify({ ...folded, id: own.id, prevId: own.prevId }, null, 2));
  unlinkSync(snapshot(next));
  unlinkSync(new URL(file, dir));
  const journalPath = new URL("meta/_journal.json", dir);
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: Array<{ idx: number }> };
  journal.entries = journal.entries.filter((entry) => entry.idx !== PAYMENT_DISPUTES_VERSION + 1);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  process.stdout.write(`Folded ${added.length} statements of ${file} into ${PAYMENT_DISPUTES_MIGRATION}\n`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  if (process.argv.includes("--fold") && !foldNextMigration()) process.stdout.write("Nothing to fold.\n");
  const path = new URL(`../migrations/${PAYMENT_DISPUTES_MIGRATION}.sql`, import.meta.url);
  if (!existsSync(path)) throw new Error(`Run pnpm db:generate first: ${PAYMENT_DISPUTES_MIGRATION}.sql is missing.`);
  const ddl = drizzleDdlOf(readFileSync(path, "utf8"));
  const result = renderPaymentDisputesMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${PAYMENT_DISPUTES_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(
    /export const CURRENT_DATABASE_SCHEMA = \{\n {2}version: \d+,\n {2}name: "[^"]+",/,
    `export const CURRENT_DATABASE_SCHEMA = {\n  version: ${PAYMENT_DISPUTES_VERSION},\n  name: "${PAYMENT_DISPUTES_MIGRATION}",`,
  );
  const entry = `  {\n    version: ${PAYMENT_DISPUTES_VERSION},\n    name: "${PAYMENT_DISPUTES_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  const existing = new RegExp(` {2}\\{\\n {4}version: ${PAYMENT_DISPUTES_VERSION},[\\s\\S]*?\\n {2}\\},\\n`);
  contract = existing.test(contract) ? contract.replace(existing, entry) : contract.replace(/\] as const;\n\nexport interface DatabaseSchemaState/, `${entry}] as const;\n\nexport interface DatabaseSchemaState`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${PAYMENT_DISPUTES_MIGRATION}: ${ddl.length} DDL statements, ${result.sqlite.split(BREAKPOINT).length} in all, digest ${result.digest}\n`);
}
