import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../testing/list-plans";
import { getProductFeedDiagnostics } from "./feed-diagnostics";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

it("takes the bounded diagnostic sample from the index on a 50,000-product catalog", async () => {
    const queries: CapturedQuery[] = [];
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    sqlite = harness.sqlite;
    // Bulk fixture only; the diagnostic itself must remain read-only.
    for (const { name } of sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()) {
        sqlite.exec(`DROP TRIGGER "${name}"`);
    }
    sqlite.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
        INSERT INTO products (id, name, slug, price_minor, updated_at, created_at)
        SELECT 'prod_' || i, 'Product ' || i, 'product-' || i, 1000, i, i FROM n`);
    const before = sqlite.prepare("SELECT total_changes() AS n").get();
    const report = await getProductFeedDiagnostics(harness.db, {
        productCatalogEnabled: true, includeUnavailableProducts: false,
        variantStrategy: "variants", title: "", description: "",
    }, { sampleLimitPerReason: 3, storefrontBaseUrl: "https://store.example.test" });

    expect(report.scan).toMatchObject({ limit: 500, scannedProducts: 500, truncated: true });
    const excluded = report.reasons.find((reason) => reason.reason === "product_feed_excluded")!;
    expect(excluded.products).toBe(500);
    expect(excluded.samples.map((sample) => sample.id)).toEqual(["prod_50000", "prod_49999", "prod_49998"]);
    expect(Object.keys(excluded.samples[0]!).sort()).toEqual(["id", "name", "reason", "slug"]);
    expect(sqlite.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    expect(queries.length).toBeLessThanOrEqual(14);
    const page = queries.find(({ query }) => query.includes('from "products"'))!;
    const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${page.query}`).all(...page.values as never[]).map((row) => String(row.detail));
    expect(plan).toContain("SCAN products USING INDEX products_feed_diagnostics_idx");
    expect(plan.some((line) => line.includes("TEMP B-TREE"))).toBe(false);
    expect(sqlite.prepare(page.query).all(...page.values as never[])).toHaveLength(501);
    for (const { query, values } of queries) {
        expect(values.length).toBeLessThanOrEqual(100);
        expect(sqlite.prepare(query).columns().length).toBeLessThanOrEqual(100);
    }
});
