// Renders migration 0222 around the DDL Drizzle Kit generated for it: its
// header, the in-flight set's statements (dispute-refund-wait.ts), the
// PostgreSQL twin compiled from the same statements, the ledger row and the
// schema contract's entry.
//
//   pnpm db:generate            (Drizzle writes the DDL, journal and snapshot)
//   pnpm exec tsx packages/database/scripts/refund-provider-processing-migration.ts --write
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateRefundSettledRequeueTrigger, REFUND_SINGLE_FLIGHT_INDEX, refundProviderProcessingStatements } from "../src/dispute-refund-wait";
import { drizzleDdlOf } from "./payment-disputes-migration";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const REFUND_PROVIDER_PROCESSING_VERSION = 222;
export const REFUND_PROVIDER_PROCESSING_MIGRATION = `0${REFUND_PROVIDER_PROCESSING_VERSION}_refund_provider_processing`;
const BREAKPOINT = "--> statement-breakpoint";

const HEADER = `-- A refund the provider took and is completing has its own status,
-- \`provider_processing\` (rules/payments/provider-processing-refund-own-status.md):
-- until now it was \`provider_unknown\` with a provider refund id and no
-- \`last_error\`, so an error written there locked the order again. The
-- attempts in that state move to it (only those rows are written), and the
-- single-flight index and the dispute requeue trigger, which name the
-- in-flight set, are recreated with it. \`needs_staff\` says a person must
-- look (a status check that needs one); it starts false on every row.
-- \`order_refunds_unsettled_idx\` lists the refunds that ended without all
-- their money going back, for Money to return. No table is rebuilt.`;

export function renderRefundProviderProcessingMigration(ddl: readonly string[]) {
  const generated = refundProviderProcessingStatements();
  const body = [...ddl.map((statement) => `${statement};`), ...generated.map((statement) => `${statement};`)];
  body[0] = `${HEADER}\n${body[0]}`;
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (${REFUND_PROVIDER_PROCESSING_VERSION}, '${REFUND_PROVIDER_PROCESSING_MIGRATION}', '${digest}');`;
  const trigger = generateRefundSettledRequeueTrigger();
  const [dropTrigger, dropIndex, mapRows, createIndex] = generated;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      `-- See ../${REFUND_PROVIDER_PROCESSING_MIGRATION}.sql.\n${compileSqliteDdlForPostgres(ddl[0]!)};`,
      ...ddl.slice(1).map((statement) => `${compileSqliteDdlForPostgres(statement)};`),
      `${dropTrigger} ON refund_attempts;`,
      `${compileSqliteDdlForPostgres(dropIndex!)};`,
      `${compileSqliteDdlForPostgres(mapRows!)};`,
      `${compileSqliteDdlForPostgres(createIndex!)};`,
      compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite }),
      ledger,
    ].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${REFUND_PROVIDER_PROCESSING_MIGRATION}.sql`, import.meta.url);
  if (!existsSync(path)) throw new Error(`Run pnpm db:generate first: ${REFUND_PROVIDER_PROCESSING_MIGRATION}.sql is missing.`);
  // Drizzle's own statements (a rendered file is read back the same way: the recreated index is not one of them).
  const ddl = drizzleDdlOf(readFileSync(path, "utf8"))
    .filter((statement) => !statement.includes(REFUND_SINGLE_FLIGHT_INDEX))
    .map((statement) => statement.replace(/;$/u, ""));
  const result = renderRefundProviderProcessingMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${REFUND_PROVIDER_PROCESSING_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(
    /export const CURRENT_DATABASE_SCHEMA = \{\n {2}version: \d+,\n {2}name: "[^"]+",/,
    `export const CURRENT_DATABASE_SCHEMA = {\n  version: ${REFUND_PROVIDER_PROCESSING_VERSION},\n  name: "${REFUND_PROVIDER_PROCESSING_MIGRATION}",`,
  );
  const entry = `  {\n    version: ${REFUND_PROVIDER_PROCESSING_VERSION},\n    name: "${REFUND_PROVIDER_PROCESSING_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  const existing = new RegExp(` {2}\\{\\n {4}version: ${REFUND_PROVIDER_PROCESSING_VERSION},[\\s\\S]*?\\n {2}\\},\\n`);
  contract = existing.test(contract) ? contract.replace(existing, entry) : contract.replace(/\] as const;\n\nexport interface DatabaseSchemaState/, `${entry}] as const;\n\nexport interface DatabaseSchemaState`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${REFUND_PROVIDER_PROCESSING_MIGRATION}: ${ddl.length} DDL statements, digest ${result.digest}\n`);
}
