import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ANALYTICS_FACT_KEYS, ANALYTICS_MEASURES, analyticsBucketsInsert, analyticsOrderFactsSelect, analyticsRollupBackfillStatements } from "../src/analytics-rollup";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const ANALYTICS_ROLLUP_MIGRATION = "0131_analytics_rollup";
const FACT_COLUMNS = [...ANALYTICS_FACT_KEYS, ...ANALYTICS_MEASURES];
const changed = (columns: readonly string[], left = "OLD", right = "NEW") => columns.map((c) => `${left}.${c} IS NOT ${right}.${c}`).join(" OR ");

export interface AnalyticsRollupTrigger { name: string; sqlite: string }

function trigger(name: string, table: string, event: string, body: string, guard?: string): AnalyticsRollupTrigger {
  return { name, sqlite: `CREATE TRIGGER ${name}\nAFTER ${event} ON ${table}${guard ? `\nWHEN ${guard}` : ""}\nBEGIN\n  ${body};\nEND` };
}

function refreshFacts(ids: string[]): string {
  const updates = FACT_COLUMNS.filter((c) => c !== "order_id");
  return `insert into analytics_order_facts (${FACT_COLUMNS.join(", ")})
    select * from (${analyticsOrderFactsSelect(`o.id in (${ids.join(", ")})`)}) as refreshed where 1 = 1
    on conflict (order_id) do update set ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}
    where ${changed(updates, "analytics_order_facts", "excluded")}`;
}

const SOURCES: ReadonlyArray<{ table: string; key: string; columns: readonly string[] }> = [
  { table: "orders", key: "id", columns: ["id", "created_at", "deleted_at", "status", "shop_currency", "currency_code", "currency_decimal_places", "fx_rate", "prices_include_tax", "shipping_amount_minor", "discount_amount_minor", "tax_amount_minor", "customer_id", "customer_phone", "channel", "channel_source", "payment_method", "city_name", "shipping_method_id", "shipping_method_kind", "requires_shipping", "fulfillment_location_id"] },
  { table: "order_items", key: "order_id", columns: ["order_id", "quantity", "fulfillment_type", "line_subtotal_minor", "discount_amount_minor", "tax_amount_minor"] },
  { table: "order_returns", key: "order_id", columns: ["order_id", "status"] },
  { table: "order_return_lines", key: "order_id", columns: ["order_id", "return_id", "order_item_id", "approved_quantity"] },
  { table: "order_payments", key: "order_id", columns: ["order_id", "payment_type", "status", "amount_minor"] },
  { table: "cod_tracking", key: "order_id", columns: ["order_id", "cod_status"] },
];

export function generateAnalyticsRollupTriggers(): AnalyticsRollupTrigger[] {
  const triggers: AnalyticsRollupTrigger[] = [];
  for (const source of SOURCES) {
    for (const event of ["insert", "update", "delete"] as const) {
      // The fact's FK cascade owns order deletion; no source row exists to refresh then.
      if (source.table === "orders" && event === "delete") continue;
      const refs = event === "insert" ? ["NEW"] : event === "delete" ? ["OLD"] : ["OLD", "NEW"];
      triggers.push(trigger(`analytics_${source.table}_${event}`, source.table,
        event === "update" ? `UPDATE OF ${source.columns.join(", ")}` : event.toUpperCase(),
        refreshFacts(refs.map((r) => `${r}.${source.key}`)),
        event === "update" ? changed(source.columns) : undefined));
    }
  }
  for (const event of ["insert", "update", "delete"] as const) {
    const refs = event === "insert" ? [["NEW", 1] as const] : event === "delete" ? [["OLD", -1] as const] : [["OLD", -1] as const, ["NEW", 1] as const];
    const delta = refs.map(([r, sign]) => `select ${ANALYTICS_FACT_KEYS.map((c) => `${r}.${c} as ${c}`).join(", ")}, ${ANALYTICS_MEASURES.map((c) => `${sign} * ${r}.${c} as ${c}`).join(", ")}`).join(" union all ");
    triggers.push(trigger(`analytics_facts_buckets_${event}`, "analytics_order_facts", event.toUpperCase(),
      analyticsBucketsInsert(`(${delta})`, true), event === "update" ? changed(FACT_COLUMNS) : undefined));
    const identities = refs.map(([r]) => `select ${r}.identity as identity`).join(" union ");
    triggers.push(trigger(`analytics_facts_first_sale_${event}`, "analytics_order_facts", event.toUpperCase(),
      `insert into analytics_customer_first_sale (identity, first_sale_at)
      select identity, (select min(f.created_at) from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1)
      from (${identities}) as affected where 1 = 1
      on conflict (identity) do update set first_sale_at = excluded.first_sale_at
      where analytics_customer_first_sale.first_sale_at IS NOT excluded.first_sale_at`,
      event === "update" ? changed(["identity", "created_at", "order_count"]) : `${refs[0]![0]}.order_count = 1`));
    const pairs = refs.map(([r]) => `select ${r}.identity as identity, ${r}.shop_currency as shop_currency`).join(" union ");
    const local = (suffix: string) => `(select f.created_at from analytics_order_facts f
      where f.shop_currency = affected.shop_currency and f.identity = affected.identity and f.order_count = 1
      order by f.created_at ${suffix})`;
    const timestamps = ["first_sale_at", "second_sale_at", "last_sale_at", "first_sale_any_currency_at"];
    triggers.push(trigger(`analytics_facts_customer_summary_${event}`, "analytics_order_facts", event.toUpperCase(),
      `insert into analytics_customer_currency_summary (identity, shop_currency, ${timestamps.join(", ")})
      select identity, shop_currency, ${local("limit 1")}, ${local("limit 1 offset 1")}, ${local("desc limit 1")},
        (select f.created_at from analytics_order_facts f where f.identity = affected.identity and f.order_count = 1 order by f.created_at limit 1)
      from (${pairs}) as affected where 1 = 1
      on conflict (identity, shop_currency) do update set ${timestamps.map((c) => `${c} = excluded.${c}`).join(", ")}
      where ${changed(timestamps, "analytics_customer_currency_summary", "excluded")}`,
      event === "update"
        ? `(OLD.order_count = 1 OR NEW.order_count = 1) AND (${changed(["identity", "shop_currency", "created_at", "order_count"])})`
        : `${refs[0]![0]}.order_count = 1`));
  }
  // Both sibling trigger orders converge: the local UPSERT reads the facts' global minimum itself.
  for (const event of ["insert", "update"] as const) {
    triggers.push(trigger(`analytics_first_sale_summary_${event}`, "analytics_customer_first_sale", event.toUpperCase(),
      `update analytics_customer_currency_summary set first_sale_any_currency_at = NEW.first_sale_at
      where identity = NEW.identity and first_sale_any_currency_at IS NOT NEW.first_sale_at`,
      event === "update" ? changed(["first_sale_at"]) : "NEW.first_sale_at IS NOT NULL"));
  }
  return triggers;
}

const BREAKPOINT = "--> statement-breakpoint";
const migrationPath = fileURLToPath(new URL(`../migrations/${ANALYTICS_ROLLUP_MIGRATION}.sql`, import.meta.url));
const postgresPath = fileURLToPath(new URL(`../migrations/postgres/${ANALYTICS_ROLLUP_MIGRATION}.sql`, import.meta.url));

/** Drizzle generates tables/indexes/snapshot; this appends the shared set-wise backfill and triggers. */
export function renderAnalyticsRollupMigration(ddl: readonly string[]): { sqlite: string; postgres: string; digest: string } {
  const triggers = generateAnalyticsRollupTriggers();
  const body = [...ddl, ...analyticsRollupBackfillStatements().map((s) => `${s};`), ...triggers.map((t) => `${t.sqlite};`)];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (131, '${ANALYTICS_ROLLUP_MIGRATION}', '${digest}');`;
  return {
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [...ddl.map(compileSqliteDdlForPostgres), ...analyticsRollupBackfillStatements().map((s) => `${compileSqliteDdlForPostgres(s)};`), ...triggers.map((t) => compileSqliteTriggerForPostgres({ name: t.name, sql: t.sqlite })), ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    digest,
  };
}

if (process.argv.includes("--write")) {
  const ddl = readFileSync(migrationPath, "utf8").split(BREAKPOINT).map((s) => s.trim()).filter((s) => /^CREATE (?:TABLE|INDEX|UNIQUE INDEX) /i.test(s));
  if (ddl.length !== 9) throw new Error("Expected four Drizzle tables and five indexes before adding analytics maintenance.");
  const output = renderAnalyticsRollupMigration(ddl);
  writeFileSync(migrationPath, output.sqlite);
  writeFileSync(postgresPath, output.postgres);
  const contractPath = fileURLToPath(new URL("../src/schema-contract.ts", import.meta.url));
  let contract = readFileSync(contractPath, "utf8");
  contract = contract.replace(/version: 130,\n {2}name: "0130_dashboard_home_reads"/, `version: 131,\n  name: "${ANALYTICS_ROLLUP_MIGRATION}"`);
  const entry = `  {\n    version: 131,\n    name: "${ANALYTICS_ROLLUP_MIGRATION}",\n    sourceSha256: "${output.digest}",\n  },\n`;
  contract = contract.includes('version: 131,\n    name:')
    ? contract.replace(/ {2}\{\n {4}version: 131,[\s\S]*?\n {2}\},\n/, entry)
    : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${ANALYTICS_ROLLUP_MIGRATION}: ${generateAnalyticsRollupTriggers().length} triggers, digest ${output.digest}\n`);
}
