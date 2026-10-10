// The inventory list at scale: one pass over the tracked SKUs answers the
// stats and the filtered total together, and the page's ids are sorted on
// the narrow row before the option label, incoming and location subqueries
// run, for the page only. Before, each request read every SKU three times
// and computed the subqueries for every SKU it sorted (1.2 s cold, 177 ms
// warm at 156,000 SKUs); the alerts tab sorted the same way.
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CapturedQuery } from "../../testing/list-plans";
import { getInventoryOverview } from "./inventory.service";

const harnesses: Array<{ sqlite: DatabaseSync }> = [];
afterEach(() => {
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

function setup() {
    const queries: CapturedQuery[] = [];
    const harness = createSqliteD1Database({ onQuery: (query, values) => queries.push({ query, values }) });
    harnesses.push(harness);
    harness.sqlite.exec(`
        INSERT INTO products (id, name, slug, price_minor) VALUES ('prod_kettle', 'Kettle', 'kettle', 1000), ('prod_mug', 'Mug', 'mug', 500);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory) VALUES
            ('var_kettle', 'prod_kettle', 'KET-1', 1000, 5, 1, 1, 1),
            ('var_mug', 'prod_mug', 'MUG-1', 500, 0, 0, 1, 1);
    `);
    return { ...harness, queries };
}

const base = { search: "", status: "all", page: 1, limit: 20, sort: "available", order: "asc" } as const;

type VariantsSection = {
    variants: Array<{ id: string }>;
    pagination: { total: number };
    stats: Record<string, number>;
};
type AlertsSection = { alerts: Array<{ variantId: string }> };

describe("inventory list at scale", () => {
    it("reads the SKUs twice: the page by id, and one pass for the stats and the total", async () => {
        const { db, queries } = setup();
        const result = await getInventoryOverview(db, { section: "variants", ...base, search: "ket" }) as VariantsSection;
        expect(result.variants.map((variant) => variant.id)).toEqual(["var_kettle"]);
        expect(result.pagination.total).toBe(1);
        expect(result.stats).toMatchObject({ totalVariants: 2, totalOnHand: 5, totalReserved: 1, outOfStockCount: 1 });

        const reads = queries.filter(({ query }) => /from "product_variants"/.test(query));
        expect(reads).toHaveLength(2);
        const page = reads.find(({ query }) => /group_concat/.test(query))!;
        // The option label is computed only for the page's ids.
        expect(page.query).toMatch(/where "product_variants"\."id" in \(select "product_variants"\."id" from "product_variants"/);
    });

    it("sorts the alerts tab on the narrow row too", async () => {
        const { db, queries } = setup();
        const result = await getInventoryOverview(db, { section: "alerts", ...base, alertStatus: "active" }) as AlertsSection;
        expect(result.alerts.map((alert) => alert.variantId)).toEqual(["var_mug"]);
        const page = queries.find(({ query }) => /group_concat/.test(query))!;
        expect(page.query).toMatch(/where "product_variants"\."id" in \(select "product_variants"\."id" from "product_variants"/);
    });
});
