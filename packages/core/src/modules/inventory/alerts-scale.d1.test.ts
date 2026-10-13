import { afterEach, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../testing/list-plans";
import { inventorySettingsDocument } from "../products";
import { getInventoryOverview } from "./inventory.service";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

it("reads restock candidates from tracked live SKUs and preserves counts as the inherited threshold changes at scale", async () => {
    const queries: CapturedQuery[] = [];
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    sqlite = harness.sqlite;
    for (const { name } of sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").all()) {
        sqlite.exec(`DROP TRIGGER "${name}"`);
    }
    sqlite.exec(`INSERT INTO products (id, name, slug, price_minor) VALUES ('prod_scale', 'Scale', 'scale', 1000);
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
        INSERT INTO product_variants (id, product_id, sku, option_combination_key, price_minor, stock, reserved_stock, low_stock_threshold)
        SELECT 'var_' || i, 'prod_scale', 'SKU-' || i, 'option-' || i, 1000,
            CASE WHEN i % 100 = 0 THEN 0 WHEN i % 100 = 1 THEN 5 ELSE 500 END,
            CASE WHEN i % 97 = 0 THEN 10 ELSE 0 END,
            CASE WHEN i % 3 = 0 THEN NULL WHEN i % 3 = 1 THEN 0 ELSE 10 END FROM n`);
    const facts = sqlite.prepare("SELECT id, stock, reserved_stock, low_stock_threshold FROM product_variants").all();

    for (const threshold of [null, 0, 20, 600]) {
        await inventorySettingsDocument.write(harness.db, { defaultLowStockThreshold: threshold });
        queries.length = 0;
        const result = await getInventoryOverview(harness.db, {
            section: "alerts", search: "", status: "all", page: 1, limit: 50, alertStatus: "active",
        }) as { alerts: Array<{ variantId: string }>; pagination: { total: number }; defaultLowStockThreshold: number | null };
        const expected = facts.filter((row) => Number(row.stock) - Number(row.reserved_stock)
            <= Number(row.low_stock_threshold ?? threshold ?? 0))
            .sort((a, b) => (Number(a.stock) - Number(a.reserved_stock)) - (Number(b.stock) - Number(b.reserved_stock))
                || (String(a.id) < String(b.id) ? -1 : 1));
        expect(result.pagination.total).toBe(expected.length);
        expect(result.alerts.map((row) => row.variantId)).toEqual(expected.slice(0, 50).map((row) => row.id));
        expect(result.defaultLowStockThreshold).toBe(threshold);
        expect(queries).toHaveLength(2);
        for (const { query, values } of queries) {
            expect(values.length).toBeLessThanOrEqual(100);
            expect(sqlite.prepare(query).columns().length).toBeLessThanOrEqual(100);
            const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values as never[]).map((row) => String(row.detail));
            // Tracked live SKUs by index; no stock column is indexed, so reservations rewrite no entry.
            expect(plan).toContain("SEARCH product_variants USING INDEX product_variants_track_inventory_idx (track_inventory=? AND deleted_at=?)");
            expect(plan.some((line) => /^SCAN (product_variants|products)( |$)/.test(line))).toBe(false);
        }
    }
});
