// An order placed for a named customer (an app's renewal, a staff order) is
// owned by that customer's storefront account, exactly as a signed-in
// checkout is, so the buyer sees it in their account. A guest record or a
// phone-matched order never gains an account owner.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CreateOrderInput } from "../validation";
import { createOrder } from "./create";

describe("manual orders for a named customer", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
            VALUES
              ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1),
              ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
            INSERT INTO products (id, name, slug, price_minor, is_active)
            VALUES ('product_1', 'Kurta', 'kurta', 80000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
            VALUES ('variant_1', 'product_1', 'KURTA-M', 80000, 50, 0, 0, 1, 1);
            INSERT INTO customers (id, name, phone, email, account_claimed_at, phone_verified_at)
            VALUES ('cust_account', 'Ayesha', '+8801712345611', 'ayesha@example.com', unixepoch(), unixepoch()),
                   ('cust_guest', 'Karim', '+8801712345612', NULL, NULL, NULL);
        `);
    });

    afterEach(() => sqlite.close());

    const owner = (id: string) => sqlite.prepare("SELECT customer_id, account_owner_customer_id FROM orders WHERE id = ?").get(id);

    function input(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
        return {
            requestKey: crypto.randomUUID(),
            customerName: "Ayesha",
            customerPhone: "+8801712345611",
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }],
            discountAmount: null,
            shippingCharge: 80,
            ...overrides,
        };
    }

    it("files an order for an account customer under that account on both sides", async () => {
        const { id } = await createOrder(db, input({ customerId: "cust_account", channel: "app" }), null);
        expect(owner(id)).toEqual({ customer_id: "cust_account", account_owner_customer_id: "cust_account" });
    });

    it("leaves a guest record's order without an account owner", async () => {
        const { id } = await createOrder(db, input({ customerId: "cust_guest", customerName: "Karim", customerPhone: "+8801712345612" }), null);
        expect(owner(id)).toEqual({ customer_id: "cust_guest", account_owner_customer_id: null });
    });

    it("never links an order by its phone alone, even when an account proved that phone", async () => {
        const { id } = await createOrder(db, input(), null);
        const row = owner(id) as { customer_id: string; account_owner_customer_id: string | null };
        expect(row.account_owner_customer_id).toBeNull();
        expect(row.customer_id).not.toBe("cust_account");
    });
});
