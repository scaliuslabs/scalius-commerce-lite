// An order placed for a named customer (an app's renewal, a staff order) is
// owned by that customer's storefront account, exactly as a signed-in
// checkout is, so the buyer sees it in their account. A guest record or a
// phone-matched order never gains an account owner.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { CreateOrderInput } from "../validation";
import { paymentMethodsDocument } from "../../settings";
import { createManualOrder, createOrder } from "./create";

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

    it("places an invoice order unpaid with its terms and due date, and no cash collection", async () => {
        const terms = (id: string) => sqlite.prepare(`SELECT payment_method, payment_status, status, payment_terms_days,
            payment_due_at - created_at AS due_in, inventory_action FROM orders WHERE id = ?`).get(id);
        const explicit = await createOrder(db, input({ customerId: "cust_account", channel: "app", paymentMethod: "net_terms", paymentTermsDays: 45 }), null);
        expect(terms(explicit.id)).toEqual({
            payment_method: "net_terms", payment_status: "unpaid", status: "confirmed",
            payment_terms_days: 45, due_in: 45 * 86_400, inventory_action: "reserved",
        });
        // Without days: the store's net days (the default, net 30).
        const store = await createOrder(db, input({ customerId: "cust_account", paymentMethod: "net_terms" }), null);
        expect(terms(store.id)).toMatchObject({ payment_terms_days: 30, due_in: 30 * 86_400 });
        expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cod_tracking WHERE order_id IN (?, ?)").get(explicit.id, store.id)).toEqual({ n: 0 });
        // Cash on delivery keeps no terms and its collection record.
        const cod = await createOrder(db, input({ customerId: "cust_account" }), null);
        expect(terms(cod.id)).toMatchObject({ payment_method: "cod", payment_terms_days: null, due_in: null });
        expect(sqlite.prepare("SELECT COUNT(*) AS n FROM cod_tracking WHERE order_id = ?").get(cod.id)).toEqual({ n: 1 });
    });

    it("never links an order by its phone alone, even when an account proved that phone", async () => {
        const { id } = await createOrder(db, input(), null);
        const row = owner(id) as { customer_id: string; account_owner_customer_id: string | null };
        expect(row.account_owner_customer_id).toBeNull();
        expect(row.customer_id).not.toBe("cust_account");
    });

    it("lets an app or agent invoice only while the store offers invoices; staff always may", async () => {
        const invoice = () => input({ customerId: "cust_account", paymentMethod: "net_terms" });
        const count = () => (sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
        // Invoices are off (the default methods): an app or an agent is refused and nothing is written.
        await expect(createManualOrder(db, invoice(), null, { automated: true })).rejects.toMatchObject({
            details: { reason: "payment_method_unavailable" },
        });
        expect(count()).toBe(0);
        expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get()).toEqual({ reserved_stock: 0 });
        // Staff invoice a customer whether or not buyers are offered it.
        const staff = await createManualOrder(db, invoice(), "user_staff");
        expect(staff.response.id).toBeTruthy();
        // Once the store offers invoices, an app or agent may place one too.
        await paymentMethodsDocument.write(db, {
            enabledMethods: ["cod", "net_terms"],
            defaultMethod: "cod",
            netTerms: { dueInDays: 15, customerTags: [], segmentIds: [], appsDecide: false },
        });
        const app = await createManualOrder(db, invoice(), null, { automated: true });
        expect(sqlite.prepare("SELECT payment_method, payment_terms_days FROM orders WHERE id = ?").get(app.response.id))
            .toEqual({ payment_method: "net_terms", payment_terms_days: 15 });
        // Cash on delivery never reads the invoice setting.
        await expect(createManualOrder(db, input({ customerId: "cust_account" }), null, { automated: true })).resolves.toBeTruthy();
    });
});
