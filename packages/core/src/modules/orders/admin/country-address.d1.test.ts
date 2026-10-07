// Staff orders with country-aware addresses (MARKETS-DESIGN step 3a), on the
// real migrated schema: a Bangladesh order stores the same City/Thana/Area as
// before plus the canonical locality and thana; a foreign order stores what
// its country's rules require, is placed in its country's market, seeds a
// new guest record's address book, and staff may skip the rules (marked).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createMarket } from "../../markets";
import { createOrderSchema, updateOrderDetailsSchema, type CreateOrderInput } from "../validation";
import { createOrder } from "./create";
import { updateOrderDetails } from "./edit";

describe("staff orders with country-aware addresses", () => {
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
        `);
    });
    afterEach(() => sqlite.close());

    const stored = (id: string) => sqlite.prepare(`SELECT shipping_country_code AS country, shipping_address AS line1, shipping_locality AS locality,
        shipping_dependent_locality AS dependent, shipping_admin_area AS admin, shipping_postal_code AS postal,
        shipping_validation_skipped AS skipped, city, zone, city_name AS cityName, market_id AS market FROM orders WHERE id = ?`).get(id);

    function input(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
        return createOrderSchema.parse({
            requestKey: crypto.randomUUID(),
            customerName: "Rahim Uddin",
            customerPhone: "+8801712345601",
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
        });
    }

    const us = {
        shippingCountryCode: "US",
        shippingAddress: "1 Infinite Loop",
        shippingLocality: "Cupertino",
        shippingAdminArea: "California",
        shippingPostalCode: "95014",
        customerPhone: "+14155552671",
        city: null,
        zone: null,
    };

    it("keeps a Bangladesh order as before, with the canonical locality and thana", async () => {
        const { id } = await createOrder(db, input(), "staff_1");
        expect(stored(id)).toEqual({
            country: "BD", line1: "House 1, Road 2, Gulshan", locality: "Dhaka", dependent: "North", admin: null, postal: null,
            skipped: 0, city: "city_1", zone: "zone_1", cityName: "Dhaka", market: "mkt_backup",
        });
    });

    it("stores a foreign address by its rules, in its country's market, and seeds the new guest record's book", async () => {
        const usMarket = await createMarket(db, { name: "United States", status: "active", countries: ["US"], presence: null });
        const { id } = await createOrder(db, input(us), "staff_1");
        expect(stored(id)).toMatchObject({
            country: "US", line1: "1 Infinite Loop", locality: "Cupertino", admin: "CA", postal: "95014",
            skipped: 0, city: null, zone: null, market: usMarket.id,
        });
        const customerId = (sqlite.prepare("SELECT customer_id FROM orders WHERE id = ?").get(id) as { customer_id: string }).customer_id;
        expect(sqlite.prepare("SELECT country_code, line1, admin_area, is_default FROM customer_addresses WHERE customer_id = ?").all(customerId))
            .toEqual([{ country_code: "US", line1: "1 Infinite Loop", admin_area: "CA", is_default: 1 }]);
    });

    it("refuses what the country's rules require, unless staff skip them (kept, marked)", async () => {
        await expect(createOrder(db, input({ ...us, shippingPostalCode: null }), "staff_1")).rejects.toThrow("Enter the postal code.");
        const { id } = await createOrder(db, input({ ...us, shippingPostalCode: null, skipAddressValidation: true }), "staff_1");
        expect(stored(id)).toMatchObject({ country: "US", postal: null, skipped: 1, market: "mkt_backup" });
        // Bangladesh keeps its ten-character line rule; another country's line follows its own rules.
        expect(() => input({ shippingAddress: "Road 2" })).toThrow("Address must be at least 10 characters");
        expect(input({ ...us, shippingAddress: "1 Loop St" }).shippingAddress).toBe("1 Loop St");
    });

    it("edits an address across countries without moving the order's market", async () => {
        const { id } = await createOrder(db, input(), "staff_1");
        const version = (sqlite.prepare("SELECT version FROM orders WHERE id = ?").get(id) as { version: number }).version;
        const result = await updateOrderDetails(db, id, updateOrderDetailsSchema.parse({
            customerName: "Rahim Uddin",
            customerEmail: null,
            ...us,
            customerPhone: "+8801712345601",
            expectedVersion: version,
        }));
        expect(result.changedFields).toEqual(expect.arrayContaining(["shippingCountryCode", "shippingLocality", "city", "zone"]));
        expect(stored(id)).toMatchObject({ country: "US", locality: "Cupertino", admin: "CA", city: null, zone: null, market: "mkt_backup" });
    });
});
