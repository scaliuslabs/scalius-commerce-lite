// W2 (Wave B §5.1): checkout freezes the product's current warranty revision
// onto each order line inside the commit batch; no policy or an archived one
// leaves the line without a warranty, and a later policy edit never changes
// what the buyer bought.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database, type SqliteD1Statement } from "@scalius/database/testing/sqlite-d1";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "./attempts";
import { loadStorefrontCheckoutAuthority } from "./authority";
import { commitStorefrontOrderPayload } from "./commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "./prepare";
import type { CreateStorefrontOrderInput } from "../orders/types";

describe("checkout freezes the warranty revision (W2)", () => {
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
            INSERT INTO warranty_policies (id, name, provider, duration_value, duration_unit, current_revision_id, archived_at)
            VALUES ('wrp_phone_policy', '1 year brand warranty', 'brand', 1, 'years', 'wrr_phone_rev_02', NULL),
                   ('wrp_old_policy01', 'Old store warranty', 'store', 6, 'months', 'wrr_old_rev_0001', 1780000000);
            INSERT INTO warranty_policy_revisions (id, policy_id, revision, name, provider, duration_value, duration_unit)
            VALUES ('wrr_phone_rev_01', 'wrp_phone_policy', 1, '6 month brand warranty', 'brand', 6, 'months'),
                   ('wrr_phone_rev_02', 'wrp_phone_policy', 2, '1 year brand warranty', 'brand', 1, 'years'),
                   ('wrr_phone_rev_03', 'wrp_phone_policy', 3, '2 year brand warranty', 'brand', 2, 'years'),
                   ('wrr_old_rev_0001', 'wrp_old_policy01', 1, 'Old store warranty', 'store', 6, 'months');
            INSERT INTO products (id, name, slug, price_minor, is_active, warranty_policy_id) VALUES
              ('p_phone', 'Phone', 'phone', 2000000, 1, 'wrp_phone_policy'),
              ('p_case', 'Case', 'case', 50000, 1, 'wrp_old_policy01'),
              ('p_cable', 'Cable', 'cable', 30000, 1, NULL);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES
              ('v_phone', 'p_phone', 'PHONE-1', 2000000, 0, 0, 0, 1, 0, 'physical'),
              ('v_case', 'p_case', 'CASE-1', 50000, 0, 0, 0, 1, 0, 'physical'),
              ('v_cable', 'p_cable', 'CABLE-1', 30000, 0, 0, 0, 1, 0, 'physical');
            INSERT INTO shipping_methods (id, name, fee_minor, kind, pickup_address, pickup_hours)
            VALUES ('m_pickup', 'Store pickup', 0, 'pickup', 'Shop 4, Gulshan 1', '10am-8pm');
        `);
    });

    afterEach(() => sqlite.close());

    type Line = CreateStorefrontOrderInput["items"][number];

    async function checkout(items: Line[]) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Warranty Buyer",
            customerPhone: "+8801712345678",
            customerEmail: null,
            shippingAddress: null,
            city: null,
            zone: null,
            area: null,
            notes: null,
            discountCodes: [],
            shippingCharge: 0,
            shippingMethodId: "m_pickup",
            paymentMethod: "cod",
            inventoryPool: "regular",
            items,
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

    const revisions = (orderId: string) => sqlite.prepare(
        "SELECT product_id, warranty_revision_id FROM order_items WHERE order_id = ? ORDER BY product_id",
    ).all(orderId);

    it("writes the current revision of a live policy and NULL for none or archived, in the one commit batch", async () => {
        const result = await checkout([
            { productId: "p_phone", variantId: "v_phone", quantity: 1, price: 20000 },
            { productId: "p_case", variantId: "v_case", quantity: 1, price: 500 },
            { productId: "p_cable", variantId: "v_cable", quantity: 2, price: 300 },
        ]);
        expect(batches).toHaveLength(1);
        expect(revisions(result.orderId)).toEqual([
            { product_id: "p_cable", warranty_revision_id: null },
            { product_id: "p_case", warranty_revision_id: null },
            { product_id: "p_phone", warranty_revision_id: "wrr_phone_rev_02" },
        ]);
        for (const statement of batches[0]!) expect(statement.values.length).toBeLessThanOrEqual(100);
    });

    it("keeps what the buyer bought when the policy moves to a new revision", async () => {
        const result = await checkout([{ productId: "p_phone", variantId: "v_phone", quantity: 1, price: 20000 }]);
        sqlite.exec("UPDATE warranty_policies SET current_revision_id = 'wrr_phone_rev_03', version = version + 1 WHERE id = 'wrp_phone_policy'");
        expect(revisions(result.orderId)).toEqual([{ product_id: "p_phone", warranty_revision_id: "wrr_phone_rev_02" }]);
        // The frozen revision is immutable (trigger).
        expect(() => sqlite.exec(`UPDATE order_items SET warranty_revision_id = 'wrr_phone_rev_03' WHERE order_id = '${result.orderId}'`))
            .toThrow();

        const later = await checkout([{ productId: "p_phone", variantId: "v_phone", quantity: 1, price: 20000 }]);
        expect(revisions(later.orderId)).toEqual([{ product_id: "p_phone", warranty_revision_id: "wrr_phone_rev_03" }]);
    });
});
