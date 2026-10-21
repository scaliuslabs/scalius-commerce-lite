// Migration 0174: exact public facet counts per category and brand
// (product_facet_scope_counts), backfilled from a populated store and kept
// equal to their sources (`facetScopeCountsSelect`) by the triggers through
// every kind of facet, buyer-state and review-stat write.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG_SCALE_MIGRATION, migrationDdl, renderCatalogScaleMigration } from "../scripts/catalog-scale-migration";
import { generateFacetScopeCountsTriggers } from "../scripts/facet-scope-counts";
import { CURRENT_DATABASE_SCHEMA_MIGRATIONS } from "../src/schema-contract";
import { compiledMigrationSql, createMigratedSqlite } from "../src/testing/sqlite-d1";
import { scopeCountsActual as actual, scopeCountsBadSamples as badSamples, scopeCountsMutations as mutations, scopeCountsOracle as oracle, scopeCountsSeed as seed } from "./catalog-scale-fixture";

const read = (provider = "") => readFileSync(join(import.meta.dirname, `../migrations/${provider}${CATALOG_SCALE_MIGRATION.name}.sql`), "utf8");

describe(`${CATALOG_SCALE_MIGRATION.name}`, () => {
  it("reproduces both artifacts, records its digest and keeps every trigger remote-D1 safe", () => {
    const generated = renderCatalogScaleMigration(migrationDdl(read()));
    expect(generated.sqlite).toBe(read());
    expect(generated.postgres).toBe(read("postgres/"));
    expect(CURRENT_DATABASE_SCHEMA_MIGRATIONS.find((m) => m.version === CATALOG_SCALE_MIGRATION.version)?.sourceSha256).toBe(generated.digest);
    for (const trigger of generateFacetScopeCountsTriggers()) {
      const body = trigger.sqlite.slice(trigger.sqlite.indexOf("BEGIN\n"));
      expect(body.match(/;/g), trigger.name).toHaveLength(1);
      expect(body, trigger.name).not.toMatch(/\bCASE\b/i);
    }
  });

  it("backfills a populated store and keeps exact counts through every write", () => {
    const db = createMigratedSqlite({ beforeMigration: "0174_", foreignKeys: true });
    try {
      db.exec(seed);
      db.exec(compiledMigrationSql("d1", undefined, "0174_"));
      const counts = () => db.prepare(actual).all();
      expect(counts()).toEqual(db.prepare(oracle).all());
      // p1 in c1 and b1; p3 in b2 only (no category); p2 is not public.
      expect(counts()).toContainEqual({ scope_kind: "category", scope_id: "c1", facet_kind: "option", facet_key: "option.color", value_key: "red", product_count: 1 });
      expect(counts()).toContainEqual({ scope_kind: "category", scope_id: "c1", facet_kind: "brand", facet_key: "brand", value_key: "brd_scale0001", product_count: 1 });
      expect(counts()).toContainEqual({ scope_kind: "brand", scope_id: "brd_scale0001", facet_kind: "rating", facet_key: "rating", value_key: "4", product_count: 1 });
      expect(db.prepare(badSamples).all()).toEqual([]);
      for (const mutation of mutations) {
        db.exec(mutation);
        expect(counts(), mutation).toEqual(db.prepare(oracle).all());
        expect(db.prepare(badSamples).all(), mutation).toEqual([]);
      }
    } finally {
      db.close();
    }
  }, 120_000);

  it("hands a value's sample to the scope's next product when its product stops counting", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(seed);
      db.exec(`INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
        VALUES ('p3','p3',NULL,'attribute','material','cotton','COTTON'); UPDATE product_buyer_state SET brand_id='brd_scale0001' WHERE product_id='p3'`);
      const sample = () => db.prepare(`SELECT sample_product_id AS id FROM product_facet_scope_counts
        WHERE scope_kind='brand' AND scope_id='brd_scale0001' AND facet_key='material' AND value_key='cotton'`).get() as { id: string };
      expect(sample().id).toBe("p1");
      db.exec("DELETE FROM product_facet_values WHERE owner_id='p1' AND facet_key='material'");
      expect(sample().id).toBe("p3");
      db.exec(`INSERT INTO product_facet_values (owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
        VALUES ('p1','p1',NULL,'attribute','material','cotton','Cotton')`);
      // A product that starts counting later never takes the sample over.
      expect(sample().id).toBe("p3");
    } finally { db.close(); }
  });

  it("writes one count per scope for 99 equal SKU values, and none for metadata or stock-only changes", () => {
    const db = createMigratedSqlite();
    try {
      db.exec(seed);
      db.exec("DELETE FROM product_facet_values WHERE product_id='p1'");
      let writes = 0;
      db.function("count_write", () => { writes += 1; return 0; });
      for (const event of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER count_${event} AFTER ${event} ON product_facet_scope_counts BEGIN SELECT count_write(); END`);
      for (let index = 0; index < 99; index += 1) {
        db.exec(`INSERT INTO product_variants(id,product_id,sku,option_combination_key) VALUES ('many_${index}','p1','MANY_${index}','${index}')`);
        db.exec(`INSERT INTO product_facet_values(owner_id,product_id,variant_id,facet_kind,facet_key,value_key,value_label)
          VALUES ('many_${index}','p1','many_${index}','option','option.size','large','Large')`);
      }
      // One row in its category and one in its brand.
      expect(writes).toBe(2);
      db.exec("UPDATE product_facet_values SET value_label='LARGE',sort_order=2 WHERE product_id='p1'; UPDATE product_buyer_state SET available_for_sale=1,refreshed_at=20,from_minor=90 WHERE product_id='p1'");
      expect(writes).toBe(2);
      expect(db.prepare(actual).all()).toEqual(db.prepare(oracle).all());
    } finally { db.close(); }
  });
});
