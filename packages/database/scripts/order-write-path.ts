import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyticsFactsBackfillStatement, generateAnalyticsRollupTriggers } from "../src/analytics-rollup";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const ORDER_WRITE_PATH_MIGRATION = "0146_order_write_path";
const BREAKPOINT = "--> statement-breakpoint";

/** Projection triggers this migration replaces (0131, 0133) or retires with their table (0140). */
const sources = ["orders", "order_items", "order_returns", "order_return_lines", "order_payments", "cod_tracking"];
export const RETIRED_TRIGGERS: ReadonlyArray<readonly [name: string, table: string]> = [
  ...sources.flatMap((table) => ["insert", "update", "delete"]
    .filter((event) => table !== "orders" || event !== "delete")
    .map((event) => [`analytics_${table}_${event}`, table] as const)),
  ...["buckets", "first_sale", "customer_summary"].flatMap((kind) => ["insert", "update", "delete"]
    .map((event) => [`analytics_facts_${kind}_${event}`, "analytics_order_facts"] as const)),
  ["analytics_first_sale_summary_insert", "analytics_customer_first_sale"],
  ["analytics_first_sale_summary_update", "analytics_customer_first_sale"],
  ...["insert", "update", "delete"].map((event) => [`buyer_public_counts_${event}`, "product_buyer_state"] as const),
];

/**
 * Drizzle owns the DDL, journal and snapshot. Around it: retire the old
 * triggers first (they read dropped columns), fill the facts once from the
 * sources, and install the delta triggers. No day is sealed yet: maintenance
 * seals finished days, and until then readers take them from facts.
 */
export function renderOrderWritePathMigration(ddl: readonly string[]) {
  const triggers = generateAnalyticsRollupTriggers();
  const seed = [`${analyticsFactsBackfillStatement()};`];
  const body = [
    ...RETIRED_TRIGGERS.map(([name]) => `DROP TRIGGER IF EXISTS ${name};`),
    ...ddl, ...seed, ...triggers.map((trigger) => `${trigger.sqlite};`),
  ];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (146, '${ORDER_WRITE_PATH_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [
      ...RETIRED_TRIGGERS.map(([name, table]) => `DROP TRIGGER IF EXISTS ${name} ON ${table};`),
      ...[...ddl, ...seed].map(compileSqliteDdlForPostgres),
      ...triggers.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ledger,
    ].join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${ORDER_WRITE_PATH_MIGRATION}.sql`, import.meta.url);
  const ddl = readFileSync(path, "utf8").split(BREAKPOINT).map((s) => s.trim())
    .filter((s) => /^(?:CREATE (?:TABLE|INDEX)|DROP (?:TABLE|INDEX)|ALTER TABLE) /i.test(s));
  if (ddl.length !== 23) throw new Error(`Expected the 23 Drizzle statements of ${ORDER_WRITE_PATH_MIGRATION}, found ${ddl.length}.`);
  const result = renderOrderWritePathMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${ORDER_WRITE_PATH_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(/version: 145,\n {2}name: "0145_conversation_search_cursor"/, `version: 146,\n  name: "${ORDER_WRITE_PATH_MIGRATION}"`);
  const entry = `  {\n    version: 146,\n    name: "${ORDER_WRITE_PATH_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  contract = contract.includes('version: 146,\n    name:') ? contract.replace(/ {2}\{\n {4}version: 146,[\s\S]*?\n {2}\},\n/, entry) : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${ORDER_WRITE_PATH_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
