// Promotions limited to customer segments through a real prepare and the one
// commit batch: the quote and the commit re-check evaluate the same buyer
// (the signed-in account, or a guest), so a guest whose verified phone links
// the order to a member's account never gets a false "discount changed",
// while a member who leaves the segment mid-checkout does.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { createCustomerSegment } from "../customers/customer-segments";
import { activatePromotion, createPromotionDraft, type CreatePromotionDraftInput } from "../promotions";
import type { CreateStorefrontOrderCustomerIdentity, CreateStorefrontOrderInput } from "../orders/types";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "./attempts";
import { loadStorefrontCheckoutAuthority } from "./authority";
import { commitStorefrontOrderPayload } from "./commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "./prepare";

const VIP_PHONE = "+8801712345678";

describe("segment-limited promotions at checkout", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(async () => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('p_honey', 'Honey', 'honey', 90000, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES ('v_honey', 'p_honey', 'HONEY-1', 90000, 100, 0, 0, 1, 1, 'physical');
            INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at)
            VALUES ('cust_vip', 'Vip', '${VIP_PHONE}', 'account', 1700000000, 1700000000);
            INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_vip', 'vip');
        `);
        const vip = await createCustomerSegment(db, {
            name: "VIP",
            definition: { conditions: [{ field: "tags", op: "has_any", tags: ["vip"] }] },
        }, null);
        const orderOff = (basisPoints: number): CreatePromotionDraftInput["effects"] => [
            { kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints } },
        ];
        for (const rule of [
            { name: "VIP 20%", customerSegmentIds: [vip.id], effects: orderOff(2_000) },
            { name: "Everyone 5%", effects: orderOff(500) },
        ]) {
            const created = await createPromotionDraft(db, { method: "automatic", ...rule });
            await activatePromotion(db, created.id, created.revision);
        }
    });

    afterEach(() => sqlite.close());

    async function prepare(customerIdentity?: CreateStorefrontOrderCustomerIdentity) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Honey Buyer",
            customerPhone: VIP_PHONE,
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            discountCodes: [],
            shippingCharge: 0,
            shippingMethodId: "m_ship",
            paymentMethod: "cod",
            inventoryPool: "regular",
            items: [{ productId: "p_honey", variantId: "v_honey", quantity: 1, price: 900 }],
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
            customerIdentity,
            { code: "BDT", decimalPlaces: 2, priceIncrementMinor: 100 },
            createTrustedStorefrontCheckoutPolicySnapshot({
                partialPaymentEnabled: false,
                authorityRevision: authority.authorityRevision,
                orderCreatedNotificationEnabled: false,
                metaPurchaseEnabled: false,
            }),
            authority.taxAuthority,
        );
        return {
            result,
            commit: () => commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } }),
        };
    }

    const committed = (orderId: string) => ({
        ...(sqlite.prepare("SELECT customer_id AS customerId, discount_amount_minor AS discount FROM orders WHERE id = ?").get(orderId) as object),
        promotions: (sqlite.prepare("SELECT DISTINCT promotion_name AS name FROM order_discount_allocations WHERE order_id = ?")
            .all(orderId) as Array<{ name: string }>).map(({ name }) => name),
    });

    it("gives the signed-in member the segment discount and commits it", async () => {
        const member = await prepare({ customerId: "cust_vip", source: "authenticated" });
        expect(member.result.commitPayload.promotion?.applied.discounts.map(({ promotionName }) => promotionName)).toEqual(["VIP 20%"]);
        await member.commit();
        expect(committed(member.result.orderId)).toEqual({ customerId: "cust_vip", discount: 18_000, promotions: ["VIP 20%"] });
    });

    it("commits a guest as a guest, even when the verified phone links the order to a member", async () => {
        const guest = await prepare();
        await guest.commit();
        // The order joins the member's account by its verified phone, but the
        // guest was quoted without the member's segments, and so was the re-check.
        expect(committed(guest.result.orderId)).toEqual({ customerId: "cust_vip", discount: 4_500, promotions: ["Everyone 5%"] });
    });

    it("asks the member to review the total when they leave the segment mid-checkout", async () => {
        const member = await prepare({ customerId: "cust_vip", source: "authenticated" });
        sqlite.exec("DELETE FROM customer_tag_links WHERE customer_id = 'cust_vip'");
        await expect(member.commit()).rejects.toThrow("This discount changed while you were checking out.");
        expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 0 });
    });
});
