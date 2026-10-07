// Billing addresses at checkout (migration 0119, Shopify's rule) on the real
// migrated schema, through the route's path (one authority read, prepare, one
// commit batch): a shipped order is billed at its shipping address and binds
// nothing more; an order that ships nothing is billed, taxed and placed in
// its billing country; a pickup order is taxed where it is collected; and the
// largest order insert stays within D1's 100 bound values.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database, type SqliteD1Statement } from "@scalius/database/testing/sqlite-d1";
import { BILLING_ADDRESS_REQUIRED_REASON } from "@scalius/shared/billing-address";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "./attempts";
import { loadStorefrontCheckoutAuthority } from "./authority";
import { commitStorefrontOrderPayload } from "./commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "./prepare";
import type { CreateStorefrontOrderInput } from "../orders/types";

describe("billing addresses at checkout", () => {
    let sqlite: DatabaseSync;
    let db: Database;
    let batches: Array<readonly SqliteD1Statement[]>;

    beforeEach(() => {
        batches = [];
        ({ sqlite, db } = createSqliteD1Database({
            beforeBatch(_sqlite, statements) {
                batches.push(statements);
            },
        }));
        sqlite.exec(`
            INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
            INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh'), ('dz_de', 'Germany');
            INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd'), ('DE', 'dz_de');
            INSERT INTO shipping_methods (id, name, fee_minor, kind, zone_id) VALUES ('m_ship', 'Standard', 6000, 'delivery', 'dz_bd'), ('m_de', 'DHL', 9000, 'delivery', 'dz_de');
            INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, pickup_hours)
            VALUES ('m_pickup', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', '10am-8pm');
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_mug', 'Mug', 'mug', 30000, 1), ('p_svc', 'Setup', 'setup', 20000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES ('v_mug', 'p_mug', 'MUG-1', 30000, 50, 0, 0, 1, 1, 'physical'),
                   ('v_svc', 'p_svc', 'SETUP-1', 20000, 0, 0, 0, 1, 0, 'service');
            INSERT INTO markets (id, handle, name, status) VALUES ('mkt_de', 'germany', 'Germany', 'active');
            INSERT INTO market_countries (country_code, market_id) VALUES ('DE', 'mkt_de');
            INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
            INSERT OR REPLACE INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, display_label, version)
            VALUES ('default', 1, 0, 'tax_standard', 'VAT', 1);
            INSERT INTO tax_regions (id, country_code) VALUES ('txreg_bd', 'BD'), ('txreg_de', 'DE');
            INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps, is_active)
            VALUES ('rate_bd', 'tax_standard', 'txreg_bd', 'VAT', 1000, 1), ('rate_de', 'tax_standard', 'txreg_de', 'MwSt', 1900, 1);
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;

    type Line = CreateStorefrontOrderInput["items"][number];
    const line = (productId: string, variantId: string, quantity: number, price: number): Line =>
        ({ productId, variantId, quantity, price });
    const bdAddress = { shippingAddress: "House 1, Road 2, Dhaka", city: "city_1", zone: "zone_1", area: null };

    async function checkout(
        overrides: Partial<CreateStorefrontOrderInput> & { items: Line[] },
        options: { requireFullBillingAddress?: boolean } = {},
    ) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Billing Buyer",
            customerPhone: "+8801712345678",
            customerEmail: "buyer@example.test",
            shippingAddress: null,
            city: null,
            zone: null,
            area: null,
            notes: null,
            discountCodes: [],
            shippingCharge: 0,
            shippingMethodId: null,
            paymentMethod: "cod",
            inventoryPool: "regular",
            ...overrides,
        };
        const authority = await loadStorefrontCheckoutAuthority(db, {
            items: data.items,
            inventoryPool: data.inventoryPool,
            shippingCountryCode: data.shippingCountryCode,
            city: data.city,
            zone: data.zone,
            area: data.area,
            shippingAdminArea: data.shippingAdminArea,
            shippingPostalCode: data.shippingPostalCode,
            shippingMethodId: data.shippingMethodId,
            customerPhone: data.customerPhone,
        });
        const attempt = createAtomicCheckoutAttempt(await buildCheckoutAttemptIdentity(data));
        const result = await createStorefrontOrder(
            db,
            data,
            "https://shop.example.com/api/v1/orders",
            { orderId: attempt.orderId, checkoutToken: attempt.checkoutToken },
            authority.cartValidation,
            authority.deliveryPreflight,
            undefined,
            { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
            createTrustedStorefrontCheckoutPolicySnapshot({
                partialPaymentEnabled: false,
                authorityRevision: authority.authorityRevision,
                orderCreatedNotificationEnabled: false,
                metaPurchaseEnabled: false,
                shippingCountries: authority.shippingCountries,
                requireFullBillingAddress: options.requireFullBillingAddress ?? authority.checkoutSettings.requireFullBillingAddress,
            }),
            authority.taxAuthority,
        );
        batches = [];
        await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
        return result;
    }

    const orderInsert = () => batches.flat().find((statement) => /^insert into "orders"/i.test(statement.query))!;
    /** The columns of a one-row insert whose value is a bound parameter. */
    const boundColumns = (statement: SqliteD1Statement): string[] => {
        const match = /^insert into "[a-z_]+" \(([^)]*)\) values \(([\s\S]*)\)$/i.exec(statement.query.trim())!;
        const columns = match[1]!.split(",").map((column) => column.trim().replaceAll('"', ""));
        const values: string[] = [];
        let depth = 0;
        let current = "";
        for (const char of match[2]!) {
            if (char === "(") depth += 1;
            if (char === ")") depth -= 1;
            if (char === "," && depth === 0) {
                values.push(current.trim());
                current = "";
            } else current += char;
        }
        values.push(current.trim());
        expect(values).toHaveLength(columns.length);
        return columns.filter((_, index) => values[index] === "?");
    };

    it("bills a shipped order at its shipping address, taxed there, binding nothing more", async () => {
        const result = await checkout({ ...bdAddress, shippingMethodId: "m_ship", items: [line("p_mug", "v_mug", 1, 300)] });
        expect(one(`SELECT billing_same_as_shipping AS same, billing_country_code AS country, market_id AS market FROM orders WHERE id = ?`, result.orderId))
            .toEqual({ same: 1, country: null, market: "mkt_backup" });
        expect(one("SELECT address_source AS source FROM order_tax_snapshots WHERE order_id = ?", result.orderId)).toEqual({ source: "shipping" });
        expect(result.taxQuote.taxMinor).toBe(3_000);
        // Both billing flags are SQL literals and nothing else is written:
        // the insert binds no billing value.
        expect(boundColumns(orderInsert()).filter((column) => column.startsWith("billing_"))).toEqual([]);
    });

    it("bills, taxes and places an order that ships nothing in its billing country", async () => {
        const result = await checkout({
            paymentMethod: "stripe",
            billingCountryCode: "DE",
            billingPostalCode: "10115",
            items: [line("p_svc", "v_svc", 1, 200)],
        });
        expect(result.taxQuote).toMatchObject({ taxMinor: 3_800, jurisdiction: { countryCode: "DE", addressSource: "billing" } });
        expect(one(`SELECT billing_same_as_shipping AS same, billing_country_code AS country, billing_postal_code AS postal,
            billing_address AS line1, shipping_country_code AS shipping, market_id AS market FROM orders WHERE id = ?`, result.orderId))
            .toEqual({ same: 0, country: "DE", postal: "10115", line1: null, shipping: null, market: "mkt_de" });
        expect(one("SELECT address_source AS source FROM order_tax_snapshots WHERE order_id = ?", result.orderId)).toEqual({ source: "billing" });
        expect(one("SELECT country_code AS country, tax_region_id AS region FROM order_item_tax_snapshots WHERE order_id = ?", result.orderId))
            .toEqual({ country: "DE", region: "txreg_de" });
    });

    it("refuses an order that ships nothing without a billing country when the store sells to several", async () => {
        await expect(checkout({ paymentMethod: "stripe", items: [line("p_svc", "v_svc", 1, 200)] }))
            .rejects.toMatchObject({ details: { reason: BILLING_ADDRESS_REQUIRED_REASON } });
        expect(one("SELECT count(*) AS n FROM orders")).toEqual({ n: 0 });
    });

    it("taxes a pickup order where it is collected and asks no billing address", async () => {
        const result = await checkout({ shippingMethodId: "m_pickup", items: [line("p_mug", "v_mug", 1, 300)] });
        expect(result.taxQuote.jurisdiction).toMatchObject({ countryCode: "BD", addressSource: "origin" });
        expect(one("SELECT billing_same_as_shipping AS same, billing_country_code AS country FROM orders WHERE id = ?", result.orderId))
            .toEqual({ same: 0, country: null });
    });

    it("keeps the largest order insert within D1's 100 bound values", async () => {
        // A foreign delivery with every shipping field and a separate, full billing address.
        const result = await checkout({
            shippingCountryCode: "DE",
            shippingAddress: "Hauptstrasse 1",
            shippingAddressLine2: "Hinterhaus, 3. OG",
            shippingLocality: "Berlin",
            shippingPostalCode: "10115",
            shippingMethodId: "m_de",
            customerWhatsapp: "+8801712345679",
            notes: "Ring twice",
            paymentMethod: "stripe",
            billingSameAsShipping: false,
            billingCountryCode: "DE",
            billingName: "Firma GmbH Buchhaltung",
            billingCompany: "Firma GmbH",
            billingAddress: "Friedrichstrasse 100",
            billingAddressLine2: "Etage 4",
            billingLocality: "Berlin",
            billingPostalCode: "10117",
            items: [line("p_mug", "v_mug", 1, 300)],
        }, { requireFullBillingAddress: true });
        expect(orderInsert().values.length).toBeLessThanOrEqual(100);
        expect(one(`SELECT billing_same_as_shipping AS same, billing_name AS name, billing_address AS line1, billing_postal_code AS postal,
            shipping_postal_code AS shipping FROM orders WHERE id = ?`, result.orderId))
            .toEqual({ same: 0, name: "Firma GmbH Buchhaltung", line1: "Friedrichstrasse 100", postal: "10117", shipping: "10115" });
        // Taxed at the shipping address.
        expect(result.taxQuote.jurisdiction).toMatchObject({ countryCode: "DE", addressSource: "shipping" });
    });
});
