// Quantity bundles end to end on the real migrated schema: the `bundles`
// product section, the checkout authority read, prepare, the one commit
// batch, and how bundles combine with promotions (bundle-discounts.ts).
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePromotion, createPromotionDraft, createPromotionDraftSchema } from "../promotions";
import { buildStorefrontTaxAllocationLineId, calculateStorefrontTaxQuote } from "../tax";
import { productSemanticSectionPatchSchema, updateProductSemanticSection } from "../products/semantic-sections";
import { getProductSemanticSection } from "../products/semantic-sections";
import { getStorefrontProductBySlug } from "../catalog/product-page";
import { buildCheckoutAttemptIdentity, createAtomicCheckoutAttempt } from "./attempts";
import { loadStorefrontCheckoutAuthority } from "./authority";
import { applyBundleSavingsToDiscountAllocation } from "./bundle-discounts";
import { commitStorefrontOrderPayload } from "./commit";
import { createStorefrontOrder, createTrustedStorefrontCheckoutPolicySnapshot } from "./prepare";
import { validateStorefrontCartItems } from "./cart-validation";
import { quoteStorefrontDiscount } from "../promotions";
import type { CreateStorefrontOrderInput } from "../orders/types";

describe("quantity bundles at checkout", () => {
    let sqlite: DatabaseSync;
    let db: Database;

    beforeEach(() => {
        ({ sqlite, db } = createSqliteD1Database());
        sqlite.exec(`
            INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
            VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
            INSERT INTO shipping_methods (id, name, fee_minor, kind) VALUES ('m_ship', 'Standard', 6000, 'delivery');
            INSERT INTO products (id, name, slug, price_minor, is_active) VALUES
              ('p_honey', 'Honey', 'honey', 90000, 1),
              ('p_ghee', 'Ghee', 'ghee', 120000, 1);
            INSERT INTO products (id, name, slug, price_minor, is_active, is_gift_card) VALUES ('p_card', 'Gift card', 'gift', 100000, 1, 1);
            INSERT INTO product_variants
              (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
            VALUES
              ('v_honey', 'p_honey', 'HONEY-1', 90000, 100, 0, 0, 1, 1, 'physical'),
              ('v_ghee', 'p_ghee', 'GHEE-1', 120000, 100, 0, 0, 1, 1, 'physical');
        `);
    });

    afterEach(() => sqlite.close());

    const one = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).get(...params) as T;
    const all = <T = Record<string, unknown>>(query: string, ...params: Array<string | number>) =>
        sqlite.prepare(query).all(...params) as T[];
    const authorityRevision = () => one<{ r: number }>("SELECT revision AS r FROM checkout_authority WHERE id = 'default'").r;
    const aggregateRevision = (id: string) => one<{ r: number }>("SELECT aggregate_revision AS r FROM products WHERE id = ?", id).r;

    const setTiers = (productId: string, tiers: unknown[]) => updateProductSemanticSection(db, productId, productSemanticSectionPatchSchema.parse({
        section: "bundles",
        expectedAggregateRevision: aggregateRevision(productId),
        tiers,
    }) as never);
    const pair = { quantity: 2, discountType: "percentage", discountPercentage: 10, label: "Pair", isActive: true };
    const threeFor = { quantity: 3, discountType: "fixed_price", price: 2_400, label: "Family pack", isActive: true };

    type Line = CreateStorefrontOrderInput["items"][number];
    const line = (productId: string, variantId: string, quantity: number, price: number): Line => ({ productId, variantId, quantity, price });

    async function prepare(items: Line[], discountCodes: string[] = []) {
        const data: CreateStorefrontOrderInput = {
            checkoutRequestId: `request_${crypto.randomUUID()}`,
            expectedQuoteFingerprint: "taxq_unused_in_core_tests0",
            customerName: "Bundle Buyer",
            customerPhone: "+8801712345678",
            customerEmail: null,
            shippingAddress: "House 1, Road 2, Gulshan",
            city: "city_1",
            zone: "zone_1",
            area: null,
            notes: null,
            discountCodes,
            shippingCharge: 0,
            shippingMethodId: "m_ship",
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
        return { data, result, commit: () => commitStorefrontOrderPayload(db, result.commitPayload, { attempt, response: { orderId: result.orderId } }) };
    }

    async function checkout(items: Line[], discountCodes: string[] = []) {
        const prepared = await prepare(items, discountCodes);
        await prepared.commit();
        return prepared.result;
    }

    /** What the tax-quote route shows the buyer for the same cart (the route's own steps). */
    async function buyerQuote(items: Line[], codes: string[] = []) {
        const cart = await validateStorefrontCartItems(db, items, { currencyCode: "BDT" });
        const lines = cart.items.map((item) => ({
            id: buildStorefrontTaxAllocationLineId(item.index, item.variantId),
            productId: item.productId,
            variantId: item.variantId,
            unitPriceMinor: item.unitPriceMinor,
            quantity: item.quantity,
        }));
        const discount = await quoteStorefrontDiscount(db, {
            codes,
            customerPhone: "+8801712345678",
            cart: { currencyCode: "BDT", lines, shippingAmountMinor: 6000 },
        });
        const bundle = applyBundleSavingsToDiscountAllocation(
            cart.items.map((item, index) => ({ lineId: lines[index]!.id, unitPriceMinor: item.unitPriceMinor, quantity: item.quantity, bundleDiscountMinor: item.bundleDiscountMinor ?? 0 })),
            discount.taxAllocation,
        );
        return calculateStorefrontTaxQuote(db, {
            destination: { city: "city_1", zone: "zone_1", area: null, cityName: "Dhaka", zoneName: "North", areaName: null },
            lines: lines.map((each) => ({ lineId: each.id, productId: each.productId, variantId: each.variantId, unitPriceMinor: each.unitPriceMinor, quantity: each.quantity, taxClassId: null })),
            shippingMinor: 6000,
            promotionDiscountAllocation: bundle.allocation,
            currency: { code: "BDT", decimalPlaces: 2 },
        });
    }

    const order = (id: string) => one<{ subtotal: number; discount: number; total: number }>(
        "SELECT subtotal_amount_minor AS subtotal, discount_amount_minor AS discount, total_amount_minor AS total FROM orders WHERE id = ?", id);
    const itemDiscounts = (id: string) => all<{ q: number; d: number }>(
        "SELECT quantity AS q, discount_amount_minor AS d FROM order_items WHERE order_id = ? ORDER BY rowid", id).map((row) => [row.q, row.d]);

    it("edits tiers under the product revision, in whole taka, and fences checkouts only when prices change", async () => {
        const before = authorityRevision();
        await setTiers("p_honey", [pair, threeFor]);
        expect(authorityRevision()).toBe(before + 2);
        await expect(getProductSemanticSection(db, "p_honey", "bundles", { offset: 0, limit: 20 })).resolves.toMatchObject({
            section: "bundles",
            items: [
                { quantity: 2, discountType: "percentage", discountPercentage: 10, price: null, label: "Pair", isActive: true },
                { quantity: 3, discountType: "fixed_price", discountPercentage: null, price: 2_400, label: "Family pack" },
            ],
        });
        // Saving the same tiers again moves nothing checkout reads.
        await setTiers("p_honey", [pair, threeFor]);
        expect(authorityRevision()).toBe(before + 2);
        // A label is not a price.
        await setTiers("p_honey", [{ ...pair, label: "Two jars" }, threeFor]);
        expect(authorityRevision()).toBe(before + 2);
        await setTiers("p_honey", [{ ...pair, discountPercentage: 15 }, threeFor]);
        expect(authorityRevision()).toBe(before + 3);

        await expect(setTiers("p_honey", [{ ...threeFor, price: 2_399.5 }])).rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
        expect(() => productSemanticSectionPatchSchema.parse({
            section: "bundles", expectedAggregateRevision: 1, tiers: [pair, { ...pair, discountPercentage: 5 }],
        })).toThrow();
        await expect(setTiers("p_card", [pair])).rejects.toMatchObject({ status: 400, details: { field: "bundles" } });

        await setTiers("p_honey", []);
        expect(one("SELECT count(*) AS n FROM product_bundles")).toEqual({ n: 0 });
    });

    it("prices tiers exactly as the product page shows them, per product across lines", async () => {
        await setTiers("p_honey", [pair, threeFor]);
        const page = await getStorefrontProductBySlug(db, "honey");
        expect(page!.product.bundles).toEqual([
            { quantity: 2, discountType: "percentage", discountPercentage: 10, price: null, label: "Pair", isActive: true },
            { quantity: 3, discountType: "fixed_price", discountPercentage: null, price: 2_400, label: "Family pack", isActive: true },
        ]);

        const single = await checkout([line("p_honey", "v_honey", 1, 900)]);
        expect(order(single.orderId)).toEqual({ subtotal: 90_000, discount: 0, total: 96_000 });

        // Two jars: 10% off each, ৳180.
        const two = await checkout([line("p_honey", "v_honey", 2, 900)]);
        expect(order(two.orderId)).toEqual({ subtotal: 180_000, discount: 18_000, total: 168_000 });

        // Four jars over two lines reach "3 for ৳2,400": one set (৳300 off) and one jar at ৳900.
        const four = await checkout([line("p_honey", "v_honey", 2, 900), line("p_honey", "v_honey", 2, 900), line("p_ghee", "v_ghee", 1, 1_200)]);
        expect(order(four.orderId)).toEqual({ subtotal: 480_000, discount: 30_000, total: 456_000 });
        expect(itemDiscounts(four.orderId)).toEqual([[2, 20_000], [2, 10_000], [1, 0]]);
        expect((await buyerQuote([line("p_honey", "v_honey", 2, 900), line("p_honey", "v_honey", 2, 900), line("p_ghee", "v_ghee", 1, 1_200)])).totalMinor)
            .toBe(456_000);
        for (const row of all<{ d: number }>("SELECT discount_amount_minor AS d FROM order_items")) expect(row.d % 100).toBe(0);
    });

    it("refuses an order priced from tiers that changed before it committed", async () => {
        await setTiers("p_honey", [pair]);
        const stale = await prepare([line("p_honey", "v_honey", 2, 900)]);
        await setTiers("p_honey", [{ ...pair, discountPercentage: 50 }]);
        await expect(stale.commit()).rejects.toThrow("Checkout details changed");
        expect(one("SELECT count(*) AS n FROM orders")).toEqual({ n: 0 });
    });

    it("adds bundle savings to promotions evaluated at catalog prices, never past a line's amount", async () => {
        await setTiers("p_honey", [pair]);
        const now = Math.floor(Date.now() / 1_000);
        const automatic = await createPromotionDraft(db, createPromotionDraftSchema.parse({
            name: "Ten off",
            method: "automatic",
            effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 1_000 } }],
        }));
        await activatePromotion(db, automatic.id, automatic.revision, now - 60);

        // 10% promotion on the ৳1,800 catalog amount (৳180) plus the pair's 10% (৳180).
        const stacked = await checkout([line("p_honey", "v_honey", 2, 900)]);
        expect(order(stacked.orderId)).toEqual({ subtotal: 180_000, discount: 36_000, total: 150_000 });
        expect(one("SELECT sum(discount_amount_minor) AS n FROM order_discount_allocations WHERE order_id = ?", stacked.orderId)).toEqual({ n: 18_000 });
        expect((await buyerQuote([line("p_honey", "v_honey", 2, 900)])).totalMinor).toBe(150_000);

        // A code that makes the goods free (it beats the automatic one) leaves the bundle nothing to take.
        const free = await createPromotionDraft(db, createPromotionDraftSchema.parse({
            name: "FREEJARS",
            method: "code",
            codes: [{ code: "FREEJARS" }],
            effects: [{ kind: "percentage_off", target: "order", allocation: "once", config: { basisPoints: 10_000 } }],
        }));
        await activatePromotion(db, free.id, free.revision, now - 60);
        const freeOrder = await checkout([line("p_honey", "v_honey", 2, 900)], ["FREEJARS"]);
        expect(order(freeOrder.orderId)).toEqual({ subtotal: 180_000, discount: 180_000, total: 6_000 });
        expect(itemDiscounts(freeOrder.orderId)).toEqual([[2, 180_000]]);
    });
});
