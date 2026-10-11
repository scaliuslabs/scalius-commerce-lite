import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyticsCustomerEndpointsBackfillStatement } from "../src/analytics-rollup";
import { generateAnalyticsCustomerSummaryTriggers } from "./analytics-rollup-triggers";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION = "0133_customer_sale_endpoints";
const BREAKPOINT = "--> statement-breakpoint";
const migrationPath = fileURLToPath(new URL(`../migrations/${ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION}.sql`, import.meta.url));

/** Extend the bounded witnesses without rewriting the released 0131 projection. */
export function renderAnalyticsCustomerEndpointsMigration(ddl: readonly string[]) {
  const triggers = generateAnalyticsCustomerSummaryTriggers();
  const before = ddl.filter((statement) => !/^CREATE INDEX /i.test(statement));
  const indexes = ddl.filter((statement) => /^CREATE INDEX /i.test(statement));
  const backfill = `${analyticsCustomerEndpointsBackfillStatement()};`;
  const drops = triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${trigger.name};`);
  const body = [...before, backfill, ...indexes, ...drops, ...triggers.map((trigger) => `${trigger.sqlite};`)];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (133, '${ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      ...[...before, backfill, ...indexes].map(compileSqliteDdlForPostgres),
      ...triggers.map((trigger) => `DROP TRIGGER IF EXISTS ${trigger.name} ON analytics_order_facts;`),
      ...triggers.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })), ledger,
    ].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const ddl = readFileSync(migrationPath, "utf8").split(BREAKPOINT).map((s) => s.trim())
    .filter((s) => /^(?:ALTER TABLE|DROP INDEX|CREATE INDEX) /i.test(s));
  if (ddl.length !== 7) throw new Error("Expected five Drizzle columns and one replaced covering index.");
  const output = renderAnalyticsCustomerEndpointsMigration(ddl);
  writeFileSync(migrationPath, output.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION}.sql`, import.meta.url), output.postgres);
  const contractPath = fileURLToPath(new URL("../src/schema-contract.ts", import.meta.url));
  let contract = readFileSync(contractPath, "utf8");
  contract = contract.replace(/version: 132,\n {2}name: "0132_recommendation_buyers"/, `version: 133,\n  name: "${ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION}"`);
  const entry = `  {\n    version: 133,\n    name: "${ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION}",\n    sourceSha256: "${output.digest}",\n  },\n`;
  contract = contract.includes('version: 133,\n    name:')
    ? contract.replace(/ {2}\{\n {4}version: 133,[\s\S]*?\n {2}\},\n/, entry)
    : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${ANALYTICS_CUSTOMER_ENDPOINTS_MIGRATION}: ${output.sqlite.split(BREAKPOINT).length} statements, digest ${output.digest}\n`);
}
