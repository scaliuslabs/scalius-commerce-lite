import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const BUYER_PUBLIC_COUNTS_MIGRATION = "0140_buyer_public_counts";
const BREAKPOINT = "--> statement-breakpoint";

function buyerDelta(ref: "OLD" | "NEW", delta: number): string {
  return ["brand", "category"].map((dimension) => `SELECT '${dimension}' AS dimension,
    ${ref}.${dimension}_id AS value_id, ${delta} AS delta
    WHERE ${ref}.is_public = 1 AND ${ref}.${dimension}_id IS NOT NULL`).join(" UNION ALL ");
}

function applyDelta(source: string): string {
  // CHECK validates the proposed INSERT even on conflict: compute the nonnegative result first.
  return `INSERT INTO product_buyer_public_counts (dimension, value_id, product_count)
    SELECT d.dimension, d.value_id,
      coalesce((SELECT c.product_count FROM product_buyer_public_counts c
        WHERE c.dimension = d.dimension AND c.value_id = d.value_id), 0) + sum(d.delta)
    FROM (${source}) d GROUP BY d.dimension, d.value_id HAVING sum(d.delta) != 0
    ON CONFLICT (dimension, value_id) DO UPDATE SET product_count = excluded.product_count`;
}

export function generateBuyerPublicCountsTriggers(): Array<{ name: string; sqlite: string }> {
  const trigger = (name: string, timing: string, event: string, source: string, guard: string) => ({
    name,
    sqlite: `CREATE TRIGGER ${name}\n${timing} ${event} ON product_buyer_state\nWHEN ${guard}\nBEGIN\n  ${applyDelta(source)};\nEND`,
  });
  return [
    trigger("buyer_public_counts_insert", "AFTER", "INSERT", buyerDelta("NEW", 1), "NEW.is_public = 1"),
    // The buyer row is present here, even when deletion originated at the product FK cascade.
    trigger("buyer_public_counts_delete", "BEFORE", "DELETE", buyerDelta("OLD", -1), "OLD.is_public = 1"),
    trigger("buyer_public_counts_update", "AFTER", "UPDATE",
      `${buyerDelta("OLD", -1)} UNION ALL ${buyerDelta("NEW", 1)}`,
      "OLD.is_public IS NOT NEW.is_public OR OLD.brand_id IS NOT NEW.brand_id OR OLD.category_id IS NOT NEW.category_id OR OLD.product_id IS NOT NEW.product_id"),
  ];
}

export const buyerPublicCountsBackfill = `INSERT INTO product_buyer_public_counts (dimension, value_id, product_count)
SELECT 'brand', brand_id, count(*) FROM product_buyer_state WHERE is_public = 1 AND brand_id IS NOT NULL GROUP BY brand_id
UNION ALL SELECT 'category', category_id, count(*) FROM product_buyer_state WHERE is_public = 1 AND category_id IS NOT NULL GROUP BY category_id;`;

export function renderBuyerPublicCountsMigration(ddl: readonly string[]) {
  const triggers = generateBuyerPublicCountsTriggers();
  const body = [...ddl, buyerPublicCountsBackfill, ...triggers.map((trigger) => `${trigger.sqlite};`)];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (140, '${BUYER_PUBLIC_COUNTS_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [...[...ddl, buyerPublicCountsBackfill].map(compileSqliteDdlForPostgres),
      ...triggers.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })), ledger]
      .join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

// Run only after the one-table Drizzle migration/snapshot has been generated.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${BUYER_PUBLIC_COUNTS_MIGRATION}.sql`, import.meta.url);
  const ddl = readFileSync(path, "utf8").split(BREAKPOINT).map((s) => s.trim()).filter((s) => /^CREATE (?:TABLE|INDEX) /i.test(s));
  if (ddl.length !== 1) throw new Error("Expected one Drizzle public dimension count table.");
  const result = renderBuyerPublicCountsMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${BUYER_PUBLIC_COUNTS_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(/version: 139,\n {2}name: "0139_recommendation_order_products"/, `version: 140,\n  name: "${BUYER_PUBLIC_COUNTS_MIGRATION}"`);
  const entry = `  {\n    version: 140,\n    name: "${BUYER_PUBLIC_COUNTS_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  contract = contract.includes('version: 140,\n    name:') ? contract.replace(/ {2}\{\n {4}version: 140,[\s\S]*?\n {2}\},\n/, entry) : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${BUYER_PUBLIC_COUNTS_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
