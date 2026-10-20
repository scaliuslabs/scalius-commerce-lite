// The one order line limit (`@scalius/shared/order-limits`) in cart
// validation: a wholesale quantity is buyable, and a line whose amount
// money cannot compute exactly is refused instead of rounded.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { validateStorefrontCartItems } from "./cart-validation";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
        INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
            ('p_tea', 'Tea', 'tea', 50000, 1),
            ('p_gold', 'Gold bar', 'gold-bar', 9000000000000, 1);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, fulfillment_kind) VALUES
            ('v_tea', 'p_tea', 'TEA-1', 50000, 1000000, 0, 1, 1, 'physical'),
            ('v_gold', 'p_gold', 'GOLD-1', 9000000000000, 10, 0, 1, 1, 'physical');
    `);
});
afterEach(() => sqlite.close());

const currency = { currencyCode: "BDT", priceIncrementMinor: 100 };

describe("cart line limits", () => {
    it("validates a wholesale line of 120 units", async () => {
        const result = await validateStorefrontCartItems(db, [{ productId: "p_tea", variantId: "v_tea", quantity: 120 }], currency);
        expect(result.issues).toEqual([]);
        expect(result.items.map((item) => item.quantity)).toEqual([120]);
    });

    it("refuses a line beyond exact money", async () => {
        const result = await validateStorefrontCartItems(db, [{ productId: "p_gold", variantId: "v_gold", quantity: 2 }], currency);
        expect(result.issues).toEqual([expect.objectContaining({ code: "quantity_unavailable", action: "reduce_quantity" })]);
    });
});
