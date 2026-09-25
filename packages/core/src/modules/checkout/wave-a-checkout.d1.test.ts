// Wave A checkout on the real migrated schema, through the same path the
// route takes (one authority read, prepare, one commit batch): line types
// and the one delivery method (F4, F13), the no-address rules (§2.7), buyer
// inputs priced by the server (P1), stock summed per SKU across property
// lines (P5), old-storefront payloads unchanged, and the D1 budget of a
// 99-line commit.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database, type SqliteD1Statement } from "@scalius/database/testing/sqlite-d1";
import { ValidationError } from "../../errors";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "./attempts";
import { loadStorefrontCheckoutAuthority } from "./authority";
import { commitStorefrontOrderPayload } from "./commit";
import {
    createStorefrontOrder,
    createTrustedStorefrontCheckoutPolicySnapshot,
    DELIVERY_ADDRESS_REQUIRED_REASON,
} from "./prepare";
import {
    resolveCartPaymentMethods,
    summarizeStorefrontCartFulfilment,
    validateStorefrontCartItems,
} from "./cart-validation";
import type { CreateStorefrontOrderInput } from "../orders/types";
import { rebuildCatalogProjections } from "../products/catalog-projections";

const CUSTOMIZATION = JSON.stringify({
    version: 1,
    fields: [
        { key: "engraving", label: "Engraving", type: "text", required: false, help: null, maxLength: 30, priceMinor: 20_000 },
        {
            key: "fit", label: "Fit", type: "select", required: true, help: null,
            options: [
                { value: "regular", label: "Regular", priceMinor: 0 },
                { value: "slim", label: "Slim", priceMinor: 10_000 },
            ],
        },
    ],
});

describe("Wave A checkout", () => {
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
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
            INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, pickup_hours)
            VALUES ('m_pickup', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', '10am-8pm');
            INSERT INTO products (id, name, slug, price_minor, is_active, customization_schema) VALUES
              ('p_tee', 'Tee', 'tee', 80000, 1, '${CUSTOMIZATION}');
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
              ('p_mug', 'Mug', 'mug', 30000, 1),
              ('p_svc', 'Setup', 'setup', 50000, 1),
              ('p_dig', 'E-book', 'ebook', 20000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES
              ('v_tee', 'p_tee', 'TEE-1', 80000, 200, 0, 0, 1, 1, 'physical'),
              ('v_mug', 'p_mug', 'MUG-1', 30000, 3, 0, 0, 1, 1, 'physical'),
              ('v_svc', 'p_svc', 'SETUP-1', 50000, 0, 0, 0, 1, 0, 'service'),
              ('v_dig', 'p_dig', 'EBOOK-1', 20000, 0, 0, 0, 1, 0, 'digital');
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];

    type Line = CreateStorefrontOrderInput["items"][number];
    const line = (productId: string, variantId: string, quantity: number, price: number, properties?: Line["properties"]): Line =>
        ({ productId, variantId, quantity, price, properties });

    async function checkout(overrides: Partial<CreateStorefrontOrderInput> & { items: Line[] }) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Wave Buyer",
            customerPhone: "+8801712345678",
            customerEmail: null,
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
            city: data.city,
            zone: data.zone,
            area: data.area,
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
            { code: "BDT", decimalPlaces: 2 },
            createTrustedStorefrontCheckoutPolicySnapshot({
                partialPaymentEnabled: false,
                authorityRevision: authority.authorityRevision,
                orderCreatedNotificationEnabled: false,
                metaPurchaseEnabled: false,
            }),
            authority.taxAuthority,
        );
        batches = [];
        await commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } });
        return result;
    }

    const address = { shippingAddress: "House 1, Road 2, Gulshan", city: "city_1", zone: "zone_1" };

    it("old-storefront payloads (address, no properties) commit exactly as before", async () => {
        const result = await checkout({ ...address, shippingMethodId: "m_ship", items: [line("p_mug", "v_mug", 1, 300)] });
        expect(result.requiresShipping).toBe(true);
        expect(one("SELECT requires_shipping, shipping_method_kind, shipping_address, shipping_amount_minor FROM orders WHERE id = ?", result.orderId))
            .toEqual({ requires_shipping: 1, shipping_method_kind: "delivery", shipping_address: "House 1, Road 2, Gulshan", shipping_amount_minor: 6000 });
        expect(one("SELECT fulfillment_type, properties, properties_price_minor, base_unit_price_minor, unit_price_minor FROM order_items WHERE order_id = ?", result.orderId))
            .toEqual({ fulfillment_type: "ship", properties: null, properties_price_minor: 0, base_unit_price_minor: 30000, unit_price_minor: 30000 });
        expect(result.linePropertiesHashes).toEqual(["none"]);
    });

    it("F4: a pickup order carries no address and only store-wide tax; a delivery order without one is refused", async () => {
        const result = await checkout({ ...address, shippingMethodId: "m_pickup", items: [line("p_mug", "v_mug", 1, 300)] });
        expect(one(`SELECT requires_shipping, shipping_method_kind, pickup_address, pickup_hours, shipping_address, city, zone, shipping_method_id
            FROM orders WHERE id = ?`, result.orderId)).toEqual({
            requires_shipping: 0, shipping_method_kind: "pickup", pickup_address: "Shop 4, Gulshan 1", pickup_hours: "10am-8pm",
            shipping_address: null, city: null, zone: null, shipping_method_id: "m_pickup",
        });
        expect(one<{ t: string }>("SELECT fulfillment_type AS t FROM order_items WHERE order_id = ?", result.orderId).t).toBe("pickup");
        expect(JSON.parse(one<{ d: string }>("SELECT destination_snapshot AS d FROM order_tax_snapshots WHERE order_id = ?", result.orderId).d))
            .toMatchObject({ city: null, zone: null });

        await expect(checkout({ shippingMethodId: "m_ship", items: [line("p_mug", "v_mug", 1, 300)] }))
            .rejects.toMatchObject({ details: { reason: DELIVERY_ADDRESS_REQUIRED_REASON } });
        // The trigger is the last line of defence for any writer.
        expect(() => sqlite.exec(`UPDATE orders SET requires_shipping = 1 WHERE id = '${result.orderId}'`)).toThrow(/shipping address required/);
    });

    it("a service-only cart has no delivery method, no fee and no address; COD is at the service", async () => {
        const result = await checkout({ ...address, shippingMethodId: "m_ship", items: [line("p_svc", "v_svc", 1, 500)] });
        expect(one("SELECT requires_shipping, shipping_method_kind, shipping_method_id, shipping_amount_minor, shipping_address, payment_method FROM orders WHERE id = ?", result.orderId))
            .toEqual({ requires_shipping: 0, shipping_method_kind: null, shipping_method_id: null, shipping_amount_minor: 0, shipping_address: null, payment_method: "cod" });
        expect(one<{ t: string }>("SELECT fulfillment_type AS t FROM order_items WHERE order_id = ?", result.orderId).t).toBe("service");
    });

    it("F13: a line whose type has no fulfiller fails closed before anything is written", async () => {
        await expect(checkout({ items: [line("p_dig", "v_dig", 1, 200)], paymentMethod: "stripe" }))
            .rejects.toMatchObject({ details: { itemIssues: [expect.objectContaining({ code: "FULFILMENT_UNAVAILABLE" })] } });
        expect(one("SELECT count(*) AS n FROM orders")).toEqual({ n: 0 });
    });

    it("P1: the server prices buyer inputs from the schema and freezes a labelled snapshot", async () => {
        await expect(checkout({ ...address, shippingMethodId: "m_ship", items: [line("p_tee", "v_tee", 1, 800)] }))
            .rejects.toMatchObject({ details: { itemIssues: [expect.objectContaining({ code: "PROPERTIES_REQUIRED", propertyKey: "fit" })] } });
        await expect(checkout({ ...address, shippingMethodId: "m_ship", items: [line("p_tee", "v_tee", 1, 800, [{ key: "fit", value: "tight" }])] }))
            .rejects.toMatchObject({ details: { itemIssues: [expect.objectContaining({ code: "PROPERTIES_INVALID" })] } });
        // A client that shows the base price only is told the price changed.
        await expect(checkout({ ...address, shippingMethodId: "m_ship", items: [line("p_tee", "v_tee", 1, 800, [{ key: "fit", value: "slim" }])] }))
            .rejects.toMatchObject({ details: { itemIssues: [expect.objectContaining({ code: "PRICE_CHANGED", currentPrice: 900 })] } });

        const result = await checkout({
            ...address,
            shippingMethodId: "m_ship",
            items: [
                line("p_tee", "v_tee", 2, 1100, [{ key: "fit", value: "slim" }, { key: "engraving", value: "  Anika " }]),
                line("p_tee", "v_tee", 1, 800, [{ key: "fit", value: "regular" }]),
            ],
        });
        const rows = all<{ properties: string; properties_price_minor: number; base_unit_price_minor: number; unit_price_minor: number }>(
            "SELECT properties, properties_price_minor, base_unit_price_minor, unit_price_minor FROM order_items WHERE order_id = ? ORDER BY unit_price_minor DESC",
            result.orderId,
        );
        expect(rows.map(({ properties: _p, ...row }) => row)).toEqual([
            { properties_price_minor: 30000, base_unit_price_minor: 80000, unit_price_minor: 110000 },
            { properties_price_minor: 0, base_unit_price_minor: 80000, unit_price_minor: 80000 },
        ]);
        expect(JSON.parse(rows[0]!.properties)).toEqual([
            { key: "engraving", type: "text", label: "Engraving", value: "Anika", displayValue: "Anika", priceMinor: 20000 },
            { key: "fit", type: "select", label: "Fit", value: "slim", displayValue: "Slim", priceMinor: 10000 },
        ]);
        expect(result.linePropertiesHashes[0]).toMatch(/^[0-9a-f]{16}$/);
        // One SKU holds the stock of both lines.
        expect(one("SELECT reserved_stock FROM product_variants WHERE id = 'v_tee'")).toEqual({ reserved_stock: 3 });
        // The snapshot is immutable (P4).
        expect(() => sqlite.exec(`UPDATE order_items SET properties_price_minor = 0 WHERE order_id = '${result.orderId}'`)).toThrow();
    });

    it("P5: stock is checked per SKU across lines with different buyer inputs", async () => {
        const validation = await validateStorefrontCartItems(db, [
            { productId: "p_mug", variantId: "v_mug", quantity: 2, cartKey: "a" },
            { productId: "p_mug", variantId: "v_mug", quantity: 2, cartKey: "b" },
        ]);
        expect(validation.valid).toBe(false);
        expect(validation.issues.map((issue) => [issue.cartKey, issue.code, issue.availableQuantity])).toEqual([
            ["a", "QUANTITY_UNAVAILABLE", 3],
            ["b", "QUANTITY_UNAVAILABLE", 3],
        ]);
        expect((await validateStorefrontCartItems(db, [
            { productId: "p_mug", variantId: "v_mug", quantity: 2 },
            { productId: "p_mug", variantId: "v_mug", quantity: 1 },
        ])).valid).toBe(true);
    });

    it("commits a 99-line order in one batch (one wave) of at most 40 statements, each within 100 bound values", async () => {
        const items = Array.from({ length: 99 }, (_, index) =>
            line("p_tee", "v_tee", 1, 1000, [{ key: "fit", value: "regular" }, { key: "engraving", value: `No ${index}` }]));
        const result = await checkout({ ...address, shippingMethodId: "m_ship", items });
        expect(batches).toHaveLength(1);
        const [batch] = batches;
        const count = (prefix: string) => batch!.filter((statement) => statement.query.startsWith(prefix)).length;
        // order_items: 18 bound values a row → 5 rows a statement → 20;
        // order_item_tax_snapshots: 6 a row → 16 rows a statement → 7;
        // the rest: 3 guards, customer + history, order, COD, one SKU hold
        // (movement + counter), the SKU's product buyer-state refresh, tax
        // snapshot, attempt and receipt = 13.
        expect(count('insert into "order_items"')).toBe(20);
        expect(count('insert into "order_item_tax_snapshots"')).toBe(7);
        expect(count('insert into "product_buyer_state"')).toBe(1);
        expect(batch!.length).toBe(40);
        expect(batch!.length).toBeLessThanOrEqual(40);
        for (const statement of batch!) expect(statement.values.length).toBeLessThanOrEqual(100);
        expect(one("SELECT count(*) AS n FROM order_items WHERE order_id = ?", result.orderId)).toEqual({ n: 99 });
        expect(one("SELECT reserved_stock FROM product_variants WHERE id = 'v_tee'")).toEqual({ reserved_stock: 99 });
    });

    it("keeps cache dependency writes inside the commit: none for stock within its band, one product for a sell-out", async () => {
        // Count what the 0093 triggers write, per commit.
        sqlite.exec(`
            CREATE TABLE amp (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
            CREATE TRIGGER amp_dep_ins AFTER INSERT ON cache_dep BEGIN INSERT INTO amp VALUES ('dep', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1; END;
            CREATE TRIGGER amp_dep_upd AFTER UPDATE ON cache_dep BEGIN INSERT INTO amp VALUES ('dep', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1; END;
            CREATE TRIGGER amp_clock AFTER UPDATE ON cache_clock BEGIN INSERT INTO amp VALUES ('clock', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1; END;
        `);
        // The steady state of a live store: projections already built.
        await rebuildCatalogProjections(db);
        const measure = async (items: Line[]) => {
            sqlite.exec("DELETE FROM amp");
            const clock = (one("SELECT seq FROM cache_clock") as { seq: number }).seq;
            batches = [];
            await checkout({ ...address, shippingMethodId: "m_ship", items });
            const counts = Object.fromEntries(all<{ k: string; n: number }>("SELECT k, n FROM amp").map((row) => [row.k, row.n]));
            return {
                statements: batches[0]!.length,
                keys: all<{ dep: string }>("SELECT dep FROM cache_dep WHERE seq > ? ORDER BY dep", clock).map((row) => row.dep),
                depWrites: counts.dep ?? 0,
                clockWrites: counts.clock ?? 0,
            };
        };
        // 99 lines of one SKU that stays in stock: the batch is unchanged and writes no key.
        const inBand = await measure(Array.from({ length: 99 }, (_, index) =>
            line("p_tee", "v_tee", 1, 1000, [{ key: "fit", value: "regular" }, { key: "engraving", value: `No ${index}` }])));
        expect(inBand).toEqual({ statements: 40, keys: [], depWrites: 0, clockWrites: 0 });
        // The last 3 mugs: the SKU and the card cross into sold out.
        const soldOut = await measure([line("p_mug", "v_mug", 3, 300)]);
        // The SKU trigger (product) and the buyer-state band trigger (product, band order of its scopes).
        expect(soldOut.keys).toEqual(["lo:band:all", "p:p_mug", "t:product_buyer_state", "t:product_variants"]);
        expect(soldOut.statements).toBeLessThanOrEqual(40);
        expect(soldOut.depWrites).toBeLessThanOrEqual(6);
        expect(soldOut.clockWrites).toBeLessThanOrEqual(2);
    });

    it("offers cash on delivery only when something is handed over in person", async () => {
        const methods = ["cod", "stripe"];
        const cart = async (variantId: string, productId: string) => summarizeStorefrontCartFulfilment(
            await validateStorefrontCartItems(db, [{ productId, variantId, quantity: 1 }]),
            null,
        );
        expect(resolveCartPaymentMethods(methods, await cart("v_mug", "p_mug"))).toEqual(["cod", "stripe"]);
        expect(resolveCartPaymentMethods(methods, await cart("v_svc", "p_svc"))).toEqual(["cod", "stripe"]);
        expect(resolveCartPaymentMethods(methods, {
            allowsCashOnDelivery: summarizeStorefrontCartFulfilment({ items: [{ fulfillmentKind: "digital", isGiftCard: false }] }, null)
                .allowsCashOnDelivery,
        })).toEqual(["stripe"]);
        expect(ValidationError).toBeDefined();
    });
});
