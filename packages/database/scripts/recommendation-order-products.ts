import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recommendationBuyerSql, recommendationOrderProductsBackfill, recommendationRealOrderSql } from "../src/derived-projections";
import { cacheDepTriggersForMigration } from "./cache-dep-triggers";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const RECOMMENDATION_ORDER_PRODUCTS_MIGRATION = "0139_recommendation_order_products";
const BREAKPOINT = "--> statement-breakpoint";
const realOrder = recommendationRealOrderSql;
const buyer = recommendationBuyerSql;
const UPSERT = `ON CONFLICT (order_id, product_id) DO UPDATE SET created_at = excluded.created_at, buyer = excluded.buyer
  WHERE recommendation_order_products.created_at IS NOT excluded.created_at
     OR recommendation_order_products.buyer IS NOT excluded.buyer`;

export { recommendationOrderProductsBackfill };

export function generateRecommendationOrderProductsTriggers(): Array<{ name: string; sqlite: string }> {
  const trigger = (name: string, event: string, table: string, body: string, guard?: string) => ({
    name,
    sqlite: `CREATE TRIGGER ${name}\nAFTER ${event} ON ${table}${guard ? `\nWHEN ${guard}` : ""}\nBEGIN\n  ${body};\nEND`,
  });
  const pairMoved = "OLD.order_id IS NOT NEW.order_id OR OLD.product_id IS NOT NEW.product_id";
  const insertPair = `INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
    SELECT o.id, NEW.product_id, o.created_at, ${buyer("o")} FROM orders o
    WHERE o.id = NEW.order_id AND ${realOrder("o")} ${UPSERT}`;
  const removePair = `DELETE FROM recommendation_order_products
    WHERE order_id = OLD.order_id AND product_id = OLD.product_id
      AND NOT EXISTS (SELECT 1 FROM order_items item WHERE item.order_id = OLD.order_id AND item.product_id = OLD.product_id)`;
  const orderChanged = ["status", "deleted_at", "created_at", "customer_phone", "customer_email"]
    .map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
  return [
    trigger("recommendation_order_products_item_insert", "INSERT", "order_items", insertPair),
    trigger("recommendation_order_products_item_delete", "DELETE", "order_items", removePair),
    trigger("recommendation_order_products_item_move_remove", "UPDATE OF order_id, product_id", "order_items", removePair, pairMoved),
    trigger("recommendation_order_products_item_move_insert", "UPDATE OF order_id, product_id", "order_items", insertPair, pairMoved),
    trigger("recommendation_order_products_order_remove", "UPDATE OF status, deleted_at", "orders",
      "DELETE FROM recommendation_order_products WHERE order_id = NEW.id",
      `(OLD.status IS NOT NEW.status OR OLD.deleted_at IS NOT NEW.deleted_at) AND NOT (${realOrder("NEW")})`),
    trigger("recommendation_order_products_order_refresh", "UPDATE OF status, deleted_at, created_at, customer_phone, customer_email", "orders",
      `INSERT INTO recommendation_order_products (order_id, product_id, created_at, buyer)
       SELECT DISTINCT NEW.id, item.product_id, NEW.created_at, ${buyer("NEW")}
       FROM order_items item WHERE item.order_id = NEW.id ${UPSERT}`,
      `(${orderChanged}) AND ${realOrder("NEW")}`),
  ];
}

export function renderRecommendationOrderProductsMigration(ddl: readonly string[]) {
  const triggers = generateRecommendationOrderProductsTriggers();
  const dependencies = cacheDepTriggersForMigration(RECOMMENDATION_ORDER_PRODUCTS_MIGRATION);
  const body = [...ddl, recommendationOrderProductsBackfill, ...triggers.map((trigger) => `${trigger.sqlite};`),
    ...dependencies.flatMap((trigger) => [`DROP TRIGGER IF EXISTS ${trigger.name};`, `${trigger.sqlite};`])];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (139, '${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [...[...ddl, recommendationOrderProductsBackfill].map(compileSqliteDdlForPostgres),
      ...triggers.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })),
      ...dependencies.flatMap((trigger) => [`DROP TRIGGER IF EXISTS ${trigger.name} ON ${trigger.table};`, `${trigger.postgres};`]), ledger]
      .join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}.sql`, import.meta.url);
  const ddl = readFileSync(path, "utf8").split(BREAKPOINT).map((s) => s.trim()).filter((s) => /^CREATE (?:TABLE|INDEX) /i.test(s));
  if (ddl.length !== 4) throw new Error("Expected one Drizzle projection table and three covering indexes.");
  const result = renderRecommendationOrderProductsMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(/version: 138,\n {2}name: "0138_facet_public_counts"/, `version: 139,\n  name: "${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}"`);
  const entry = `  {\n    version: 139,\n    name: "${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  contract = contract.includes('version: 139,\n    name:') ? contract.replace(/ {2}\{\n {4}version: 139,[\s\S]*?\n {2}\},\n/, entry) : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${RECOMMENDATION_ORDER_PRODUCTS_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
