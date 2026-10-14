import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";

import { selectReservationVariantStates } from "../inventory/reserve";
import { selectStorefrontCartProductRows, selectStorefrontCartVariantRows } from "./cart-validation";

/**
 * Query-plan guards for the reads every checkout runs. D1 carries no ANALYZE
 * statistics, so SQLite plans them by shape alone, exactly as here. Before
 * these guards the cart's product read walked the `(is_active, deleted_at)`
 * index (every live product) and the reservation read every live product's
 * SKUs: about 290,000 D1 rows read per order on a 150,000-SKU store, where
 * the cart's own ids are a handful of primary-key lookups.
 */
describe("checkout read plans", () => {
    const { db, sqlite } = createSqliteD1Database();
    const plan = (query: { toSQL(): { sql: string; params: unknown[] } }) => {
        const { sql, params } = query.toSQL();
        return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>)
            .map((row) => row.detail);
    };
    const ids = ["prod_a", "prod_b", "prod_c"];
    const skus = ["var_a", "var_b", "var_c"];

    it("reads the cart's products by primary key", () => {
        const steps = plan(selectStorefrontCartProductRows(db, ids));
        expect(steps).toContain("SEARCH products USING INDEX sqlite_autoindex_products_1 (id=?)");
        expect(steps.filter((step) => /^(SCAN|SEARCH) products\b/.test(step))).toHaveLength(1);
    });

    it("reads the cart's SKUs by id: its own and its products' live SKUs", () => {
        const steps = plan(selectStorefrontCartVariantRows(db, ids, skus));
        expect(steps.filter((step) => /^(SCAN|SEARCH) (product_variants|product_sku)\b/.test(step))).toEqual([
            "SEARCH product_variants USING INDEX sqlite_autoindex_product_variants_1 (id=?)",
            "SEARCH product_sku USING INDEX product_variants_product_live_idx (product_id=? AND deleted_at=?)",
        ]);
    });

    it("reads the reservation counters by SKU id, then each SKU's product", () => {
        const steps = plan(selectReservationVariantStates(db, skus));
        expect(steps.filter((step) => /^(SCAN|SEARCH) (products|product_variants)\b/.test(step))).toEqual([
            "SEARCH product_variants USING INDEX sqlite_autoindex_product_variants_1 (id=?)",
            "SEARCH products USING INDEX sqlite_autoindex_products_1 (id=?)",
        ]);
    });
});
