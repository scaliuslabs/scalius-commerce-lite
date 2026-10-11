import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSqliteDdlForPostgres, compileSqliteTriggerForPostgres } from "./postgres-schema";

export const FACET_PUBLIC_COUNTS_MIGRATION = "0138_facet_public_counts";
const KEYS = ["facet_kind", "facet_key", "value_key"];
const BREAKPOINT = "--> statement-breakpoint";
const equal = (left: string, right: string) => KEYS.map((key) => `${left}.${key} = ${right}.${key}`).join(" AND ");
const publicProduct = (ref: string) => `EXISTS (SELECT 1 FROM product_buyer_state b WHERE b.product_id = ${ref}.product_id AND b.is_public = 1)`;

/** BEFORE INSERT/UPDATE also runs for SQLite OR IGNORE; do not count a rejected row. */
function validFacet(ref: string): string {
  return `${ref}.owner_id IS NOT NULL AND ${ref}.product_id IS NOT NULL AND ${ref}.sort_order IS NOT NULL
    AND ${ref}.owner_id = coalesce(${ref}.variant_id, ${ref}.product_id)
    AND ((${ref}.facet_kind = 'attribute' AND ${ref}.variant_id IS NULL)
      OR (${ref}.facet_kind = 'option' AND ${ref}.variant_id IS NOT NULL AND substr(${ref}.facet_key, 1, 7) = 'option.'))
    AND length(${ref}.facet_key) BETWEEN 1 AND 120 AND length(${ref}.value_key) BETWEEN 1 AND 200
    AND length(${ref}.value_label) BETWEEN 1 AND 200`;
}

function facetDelta(ref: "OLD" | "NEW", delta: number, excludeOld: boolean): string {
  return `SELECT ${KEYS.map((key) => `${ref}.${key} AS ${key}`).join(", ")}, ${delta} AS delta
    WHERE ${publicProduct(ref)} AND NOT EXISTS (
      SELECT 1 FROM product_facet_values sibling WHERE sibling.product_id = ${ref}.product_id
      AND ${equal("sibling", ref)}${excludeOld ? " AND (sibling.owner_id != OLD.owner_id OR sibling.facet_key != OLD.facet_key)" : ""})`;
}

function buyerDelta(ref: "OLD" | "NEW", delta: number): string {
  return `SELECT DISTINCT ${KEYS.map((key) => `facet.${key}`).join(", ")}, ${delta} AS delta
    FROM product_facet_values facet WHERE facet.product_id = ${ref}.product_id AND ${ref}.is_public = 1`;
}

function applyDelta(source: string): string {
  // Form the resulting nonnegative count before UPSERT: CHECK constraints also
  // inspect the proposed INSERT value, even when its key already exists.
  return `INSERT INTO product_facet_public_counts (${KEYS.join(", ")}, product_count)
    SELECT ${KEYS.map((key) => `d.${key}`).join(", ")},
      coalesce((SELECT c.product_count FROM product_facet_public_counts c WHERE ${equal("c", "d")}), 0) + sum(d.delta)
    FROM (${source}) d GROUP BY ${KEYS.map((key) => `d.${key}`).join(", ")} HAVING sum(d.delta) != 0
    ON CONFLICT (${KEYS.join(", ")}) DO UPDATE SET product_count = excluded.product_count`;
}

export function generateFacetPublicCountsTriggers(): Array<{ name: string; sqlite: string }> {
  const trigger = (name: string, timing: string, event: string, table: string, source: string, guard?: string) => ({
    name,
    sqlite: `CREATE TRIGGER ${name}\n${timing} ${event} ON ${table}${guard ? `\nWHEN ${guard}` : ""}\nBEGIN\n  ${applyDelta(source)};\nEND`,
  });
  const groupChanged = ["product_id", ...KEYS].map((key) => `OLD.${key} IS NOT NEW.${key}`).join(" OR ");
  return [
    trigger("facet_public_counts_insert", "BEFORE", "INSERT", "product_facet_values", facetDelta("NEW", 1, false),
      `${validFacet("NEW")} AND NOT EXISTS (SELECT 1 FROM product_facet_values f WHERE f.owner_id = NEW.owner_id AND f.facet_key = NEW.facet_key)`),
    trigger("facet_public_counts_delete", "BEFORE", "DELETE", "product_facet_values", facetDelta("OLD", -1, true)),
    trigger("facet_public_counts_update", "BEFORE", "UPDATE", "product_facet_values",
      `${facetDelta("OLD", -1, true)} UNION ALL ${facetDelta("NEW", 1, true)}`,
      `(${groupChanged}) AND ${validFacet("NEW")} AND NOT EXISTS (SELECT 1 FROM product_facet_values f
        WHERE f.owner_id = NEW.owner_id AND f.facet_key = NEW.facet_key
        AND (f.owner_id != OLD.owner_id OR f.facet_key != OLD.facet_key))`),
    // AFTER makes ignored/conflicting buyer inserts and invalid OR IGNORE updates
    // harmless. DELETE must account before either FK cascade removes the rows.
    trigger("facet_public_counts_buyer_insert", "AFTER", "INSERT", "product_buyer_state", buyerDelta("NEW", 1), "NEW.is_public = 1"),
    trigger("facet_public_counts_buyer_delete", "BEFORE", "DELETE", "product_buyer_state", buyerDelta("OLD", -1), "OLD.is_public = 1"),
    trigger("facet_public_counts_buyer_update", "AFTER", "UPDATE", "product_buyer_state",
      `${buyerDelta("OLD", -1)} UNION ALL ${buyerDelta("NEW", 1)}`,
      "OLD.is_public IS NOT NEW.is_public OR OLD.product_id IS NOT NEW.product_id"),
  ];
}

export const facetPublicCountsBackfill = `INSERT INTO product_facet_public_counts (facet_kind, facet_key, value_key, product_count)
SELECT facet.facet_kind, facet.facet_key, facet.value_key, count(DISTINCT facet.product_id)
FROM product_facet_values facet JOIN product_buyer_state buyer ON buyer.product_id = facet.product_id
WHERE buyer.is_public = 1 GROUP BY facet.facet_kind, facet.facet_key, facet.value_key;`;

export function renderFacetPublicCountsMigration(ddl: readonly string[]) {
  const triggers = generateFacetPublicCountsTriggers();
  const body = [...ddl, facetPublicCountsBackfill, ...triggers.map((trigger) => `${trigger.sqlite};`)];
  const digest = createHash("sha256").update(`${body.join(`\n${BREAKPOINT}\n`)}\n`).digest("hex");
  const ledger = `INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (138, '${FACET_PUBLIC_COUNTS_MIGRATION}', '${digest}');`;
  return {
    digest,
    sqlite: [...body, ledger].join(`\n${BREAKPOINT}\n`) + "\n",
    postgres: [...[...ddl, facetPublicCountsBackfill].map(compileSqliteDdlForPostgres),
      ...triggers.map((trigger) => compileSqliteTriggerForPostgres({ name: trigger.name, sql: trigger.sqlite })), ledger]
      .join(`\n${BREAKPOINT}\n`) + "\n",
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--write")) {
  const path = new URL(`../migrations/${FACET_PUBLIC_COUNTS_MIGRATION}.sql`, import.meta.url);
  const ddl = readFileSync(path, "utf8").split(BREAKPOINT).map((s) => s.trim()).filter((s) => /^CREATE (?:TABLE|INDEX) /i.test(s));
  if (ddl.length !== 5) throw new Error("Expected one Drizzle table and four metadata indexes.");
  const result = renderFacetPublicCountsMigration(ddl);
  writeFileSync(path, result.sqlite);
  writeFileSync(new URL(`../migrations/postgres/${FACET_PUBLIC_COUNTS_MIGRATION}.sql`, import.meta.url), result.postgres);
  const contractPath = new URL("../src/schema-contract.ts", import.meta.url);
  let contract = readFileSync(contractPath, "utf8").replace(/version: 137,\n {2}name: "0137_recommendation_order_id"/, `version: 138,\n  name: "${FACET_PUBLIC_COUNTS_MIGRATION}"`);
  const entry = `  {\n    version: 138,\n    name: "${FACET_PUBLIC_COUNTS_MIGRATION}",\n    sourceSha256: "${result.digest}",\n  },\n`;
  contract = contract.includes('version: 138,\n    name:') ? contract.replace(/ {2}\{\n {4}version: 138,[\s\S]*?\n {2}\},\n/, entry) : contract.replace("] as const;", `${entry}] as const;`);
  writeFileSync(contractPath, contract);
  process.stdout.write(`Generated ${FACET_PUBLIC_COUNTS_MIGRATION}: ${result.sqlite.split(BREAKPOINT).length} statements, digest ${result.digest}\n`);
}
