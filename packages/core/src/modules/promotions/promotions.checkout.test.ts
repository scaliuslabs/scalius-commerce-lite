// The one buyer discount path on the real migrated schema (D1 and Turso):
// code + automatic candidates, product/collection scope, combinations,
// buyer-facing reasons, and the commit-time re-check.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import {
    createMigratedSqlite,
    createSqliteD1Database,
    createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";

import { buildStorefrontCheckoutQuoteFingerprint } from "../orders/checkout-quote-fingerprint";
import { calculateStorefrontTaxQuote } from "../tax";
import {
    assertDiscountCodesApplied,
    listProductBuyGetOffers,
    quoteStorefrontDiscount,
    verifyPromotionCheckoutSnapshot,
    type StorefrontDiscountCart,
} from "./promotions.checkout";
import { activatePromotion, pausePromotion } from "./promotions.lifecycle";
import { archivePromotionDraft, createPromotionDraft } from "./promotions.service";
import type { CreatePromotionDraftInput } from "./promotions.validation";

const NOW = 1_900_000_000;
let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function openStore(provider: "d1" | "turso"): Database {
    sqlite = createMigratedSqlite({ provider });
    sqlite.exec(`
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_shoes', 'Shoes', 'shoes', 'published');
        INSERT INTO products (id, name, slug, price_minor, category_id) VALUES
            ('prod_tee', 'Tee', 'tee', 50000, NULL),
            ('prod_cap', 'Cap', 'cap', 20000, NULL),
            ('prod_boot', 'Boot', 'boot', 200000, 'cat_shoes');
        INSERT INTO collections (id, name, presentation, config, is_active) VALUES
            ('col_summer', 'Summer', 'grid', '{"source":"manual","productIds":["prod_cap"]}', 1),
            ('col_shoes', 'Shoes', 'grid', '{"source":"dynamic","categoryIds":["cat_shoes"]}', 1),
            ('col_hidden', 'Hidden', 'grid', '{"source":"manual","productIds":["prod_tee"]}', 0);
        INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'One', '+8801700000001');
    `);
    return provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
}

const cart: StorefrontDiscountCart = {
    currencyCode: "BDT",
    lines: [
        { id: "cart:0:var_tee", productId: "prod_tee", variantId: "var_tee", unitPriceMinor: 50_000, quantity: 2 },
        { id: "cart:1:var_cap", productId: "prod_cap", variantId: "var_cap", unitPriceMinor: 20_000, quantity: 1 },
        { id: "cart:2:var_boot", productId: "prod_boot", variantId: "var_boot", unitPriceMinor: 200_000, quantity: 1 },
    ],
    shippingAmountMinor: 6_000,
};

type Rule = Partial<CreatePromotionDraftInput> & Pick<CreatePromotionDraftInput, "effects">;

async function live(db: Database, rule: Rule & { name: string }) {
    const created = await createPromotionDraft(db, {
        method: rule.codes ? "code" : "automatic",
        ...rule,
    });
    return activatePromotion(db, created.id, created.revision, NOW - 3_600);
}

const percentOff = (basisPoints: number, scope: Record<string, string[]> = {}) => ({
    kind: "percentage_off" as const, target: "line" as const, allocation: "across" as const, config: { basisPoints, ...scope },
});
const orderOff = (basisPoints: number) => ({
    kind: "percentage_off" as const, target: "order" as const, allocation: "once" as const, config: { basisPoints },
});
const freeShipping = { kind: "free" as const, target: "shipping" as const, allocation: "once" as const, config: {} };

function perLine(quote: Awaited<ReturnType<typeof quoteStorefrontDiscount>>) {
    return Object.fromEntries((quote.taxAllocation?.lines ?? []).map(({ lineId, amountMinor }) => [lineId, amountMinor]));
}

describe.each(["d1", "turso"] as const)("storefront discount path (%s)", (provider) => {
    type Overrides = Partial<Parameters<typeof quoteStorefrontDiscount>[1]>;
    const preview = (db: Database, codes: string[], overrides: Overrides = {}) =>
        quoteStorefrontDiscount(db, { codes, cart, customerPhone: "+8801700000009", evaluatedAtEpochSeconds: NOW, ...overrides });
    /** Commit semantics: every typed code must apply. */
    const quote = async (db: Database, code: string | null, overrides: Overrides = {}) => {
        const result = await preview(db, code ? [code] : [], overrides);
        assertDiscountCodesApplied(result);
        return result;
    };

    it("scopes a code to chosen products, manual collections, and category-based collections", async () => {
        const db = openStore(provider);
        await live(db, { name: "Tee", codes: [{ code: "TEE10" }], effects: [percentOff(1_000, { productIds: ["prod_tee"] })] });
        await live(db, { name: "Summer", codes: [{ code: "SUMMER" }], effects: [percentOff(5_000, { collectionIds: ["col_summer"] })] });
        await live(db, { name: "Shoes", codes: [{ code: "SHOES" }], effects: [percentOff(2_500, { collectionIds: ["col_shoes"] })] });
        await live(db, { name: "Hidden", codes: [{ code: "HIDDEN" }], effects: [percentOff(5_000, { collectionIds: ["col_hidden"] })] });

        expect(perLine(await quote(db, " tee10 "))).toEqual({ "cart:0:var_tee": 10_000 });
        expect(perLine(await quote(db, "SUMMER"))).toEqual({ "cart:1:var_cap": 10_000 });
        expect(perLine(await quote(db, "SHOES"))).toEqual({ "cart:2:var_boot": 50_000 });
        // An inactive collection grants nothing: the code fails closed.
        await expect(quote(db, "HIDDEN")).rejects.toThrow("does not apply to the items in your cart");
    });

    it("applies the best automatic discount with no code and refuses a weaker code", async () => {
        const db = openStore(provider);
        await live(db, { name: "Everything 20%", effects: [orderOff(2_000)] });
        await live(db, { name: "Code 10%", codes: [{ code: "TEN" }], effects: [orderOff(1_000)] });

        const automatic = await quote(db, null);
        expect(automatic.applied?.discounts).toEqual([expect.objectContaining({ method: "automatic", totalDiscountMinor: 64_000 })]);
        expect(automatic.snapshot?.cart.submittedCodes).toEqual([]);
        await expect(quote(db, "TEN")).rejects.toThrow("Your cart already gets an equal or better discount.");
    });

    it("stacks when one side allows it and keeps two exclusive discounts apart", async () => {
        const db = openStore(provider);
        await live(db, { name: "Free delivery", effects: [freeShipping] });
        await live(db, { name: "Tee half", codes: [{ code: "TEEHALF" }], combinesWith: { product: false, order: true, shipping: true }, effects: [percentOff(5_000, { productIds: ["prod_tee"] })] });
        await live(db, { name: "Solo", codes: [{ code: "SOLO" }], effects: [percentOff(1_000, { productIds: ["prod_cap"] })] });

        const stacked = await quote(db, "TEEHALF");
        expect(stacked.applied?.discounts.map(({ promotionName }) => promotionName)).toEqual(["Tee half", "Free delivery"]);
        expect(stacked.taxAllocation).toEqual({ lines: [{ lineId: "cart:0:var_tee", amountMinor: 50_000 }], shippingMinor: 6_000 });
        // Neither SOLO nor free delivery combines; alone SOLO saves less.
        await expect(quote(db, "SOLO")).rejects.toThrow("SOLO can't be combined with Free delivery.");
    });

    it("offers automatic Buy X get Y when only the free item is missing", async () => {
        const db = openStore(provider);
        await live(db, {
            name: "Buy a tee, get a cap free",
            effects: [{
                kind: "percentage_off",
                target: "line",
                allocation: "across",
                config: { basisPoints: 10_000, productIds: ["prod_cap"], getQuantity: 1, buy: { quantity: 1, productIds: ["prod_tee"] } },
            }],
        });
        const teeOnly = await quote(db, null, { cart: { ...cart, lines: [cart.lines[0]!] } });
        expect(teeOnly).toMatchObject({
            applied: null,
            offers: [{
                title: "Buy a tee, get a cap free",
                code: null,
                kind: "get",
                basisPoints: 10_000,
                quantity: 1,
                // The cap has no saved SKU in this fixture, so it links to its page instead of one-tap add.
                products: [],
            }],
        });
        expect((await quote(db, null)).offers).toEqual([]);
    });

    it("gives clear reasons for unknown, paused, archived, scheduled, and limited codes", async () => {
        const db = openStore(provider);
        await expect(quote(db, "NOPE")).rejects.toThrow("This discount code is not valid.");
        const paused = await live(db, { name: "Paused", codes: [{ code: "PAUSED" }], effects: [orderOff(1_000)] });
        await pausePromotion(db, paused.id, paused.revision);
        await expect(quote(db, "PAUSED")).rejects.toThrow("not active");
        const archived = await live(db, { name: "Archived", codes: [{ code: "GONE" }], effects: [orderOff(1_000)] });
        await archivePromotionDraft(db, archived.id, archived.revision);
        await expect(quote(db, "GONE")).rejects.toThrow("not active");
        await live(db, { name: "Later", codes: [{ code: "LATER" }], startsAtEpochSeconds: NOW + 60, effects: [orderOff(1_000)] });
        await expect(quote(db, "LATER")).rejects.toThrow("not available yet");
        await live(db, { name: "Ended", codes: [{ code: "ENDED" }], startsAtEpochSeconds: NOW - 60, endsAtEpochSeconds: NOW, effects: [orderOff(1_000)] });
        await expect(quote(db, "ENDED")).rejects.toThrow("expired");
        const once = await live(db, { name: "Once", codes: [{ code: "ONCE" }], maxRedemptionsPerCustomer: 1, effects: [orderOff(1_000)] });
        sqlite!.exec(`
            INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, shipping_amount_minor)
            VALUES ('order_1', 'One', '+8801700000001', 'Address', 'city', 'zone', 10000, 0);
            INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor) VALUES ('item_1', 'order_1', 'prod_tee', 1, 10000);
            INSERT INTO order_discount_allocations (id, order_id, order_item_id, promotion_id, effect_id, promotion_revision,
                evaluator_version, method, promotion_name, promotion_code, effect_kind, target, currency_code,
                base_amount_minor, discount_amount_minor, quantity)
            SELECT 'oda_1', 'order_1', 'item_1', '${once.id}', id, ${once.revision}, 2, 'code', 'Once', 'ONCE',
                'percentage_off', 'order', 'BDT', 10000, 1000, 1
            FROM promotion_effects WHERE promotion_id = '${once.id}';
            INSERT INTO promotion_redemptions (id, promotion_id, order_id, customer_id, promotion_revision, promotion_code,
                currency_code, discount_amount_minor)
            VALUES ('pred_1', '${once.id}', 'order_1', 'cust_1', ${once.revision}, 'ONCE', 'BDT', 1000);
        `);
        await expect(quote(db, "ONCE", { customerPhone: "+8801700000001" })).rejects.toThrow("already reached your usage limit");
        await expect(quote(db, "ONCE", { customerId: "cust_1", customerPhone: null })).rejects.toThrow("already reached your usage limit");
        await expect(quote(db, "ONCE")).resolves.toMatchObject({ applied: { totalDiscountMinor: 32_000 } });
    });

    it("applies Buy X get Y to the cheapest qualifying item", async () => {
        const db = openStore(provider);
        await live(db, {
            name: "Buy a tee, get a cap",
            effects: [{
                kind: "percentage_off",
                target: "line",
                allocation: "across",
                config: { basisPoints: 10_000, collectionIds: ["col_summer"], getQuantity: 1, buy: { quantity: 1, productIds: ["prod_tee"] } },
            }],
        });
        expect(perLine(await quote(db, null))).toEqual({ "cart:1:var_cap": 20_000 });
        const withoutTee = await quote(db, null, { cart: { ...cart, lines: cart.lines.slice(1) } });
        expect(withoutTee.applied).toBeNull();
    });

    it("re-evaluates at commit: cart edits and rule changes are caught, unchanged carts pass", async () => {
        const db = openStore(provider);
        const promotion = await live(db, { name: "Tee", codes: [{ code: "TEE10" }], effects: [percentOff(1_000, { productIds: ["prod_tee"] })] });
        const prepared = await quote(db, "TEE10");
        await expect(verifyPromotionCheckoutSnapshot(db, prepared.snapshot!, "cust_1", NOW))
            .resolves.toEqual(prepared.applied);
        const edited = { ...prepared.snapshot!, cart: { ...prepared.snapshot!.cart, lines: [{ ...cart.lines[0]!, quantity: 3 }] } };
        await expect(verifyPromotionCheckoutSnapshot(db, edited, "cust_1", NOW)).rejects.toThrow("changed while you were checking out");
        await pausePromotion(db, promotion.id, promotion.revision);
        await expect(verifyPromotionCheckoutSnapshot(db, prepared.snapshot!, "cust_1", NOW)).rejects.toThrow("not active");
    });

    it("changes the checkout quote fingerprint whenever the applied discount changes", async () => {
        const db = openStore(provider);
        await live(db, { name: "Tee", codes: [{ code: "TEE10" }], effects: [percentOff(1_000, { productIds: ["prod_tee"] })] });
        await live(db, { name: "Order", codes: [{ code: "ORDER5" }], effects: [orderOff(500)] });
        const shippingMethod = { id: "ship", name: "Standard", description: null, baseAmountMinor: 6_000, feeWaived: false };
        const fingerprint = async (code: string | null) => {
            const discount = await quote(db, code);
            const tax = await calculateStorefrontTaxQuote(db, {
                destination: { city: "c", zone: "z", area: null },
                lines: cart.lines.map((line) => ({
                    lineId: line.id, productId: line.productId, variantId: line.variantId,
                    unitPriceMinor: line.unitPriceMinor, quantity: line.quantity, taxClassId: null,
                })),
                shippingMinor: 6_000,
                promotionDiscountAllocation: discount.taxAllocation,
                currency: { code: "BDT", decimalPlaces: 2 },
            });
            return buildStorefrontCheckoutQuoteFingerprint(tax, shippingMethod);
        };
        const prints = [await fingerprint(null), await fingerprint("TEE10"), await fingerprint("ORDER5")];
        expect(new Set(prints).size).toBe(3);
        expect(await fingerprint("TEE10")).toBe(prints[1]);
    });

    it("combines codes of different classes, one line per discount, and dedupes a repeated code", async () => {
        const db = openStore(provider);
        await live(db, { name: "Tee half", codes: [{ code: "TEEHALF" }], combinesWith: { product: false, order: false, shipping: true }, effects: [percentOff(5_000, { productIds: ["prod_tee"] })] });
        await live(db, { name: "Ship free", codes: [{ code: "SHIPFREE" }], effects: [freeShipping] });
        await live(db, { name: "Order 5", codes: [{ code: "ORDER5" }], effects: [orderOff(500)] });

        const both = await preview(db, ["teehalf", "SHIPFREE", " TEEHALF "]);
        expect(both.rejectedCodes).toEqual([]);
        expect(both.discounts).toEqual([
            expect.objectContaining({ title: "Tee half", code: "TEEHALF", amountMinor: 50_000 }),
            expect.objectContaining({ title: "Ship free", code: "SHIPFREE", amountMinor: 6_000 }),
        ]);
        expect(both.snapshot?.cart.submittedCodes).toEqual(["TEEHALF", "SHIPFREE"]);

        // ORDER5 does not combine with the product code: it is listed with the reason, not silently dropped.
        const three = await preview(db, ["TEEHALF", "SHIPFREE", "ORDER5"]);
        expect(three.discounts.map(({ code }) => code)).toEqual(["TEEHALF", "SHIPFREE"]);
        expect(three.rejectedCodes).toEqual([
            expect.objectContaining({ code: "ORDER5", reason: "not_combinable", message: "ORDER5 can't be combined with TEEHALF." }),
        ]);
        expect(() => assertDiscountCodesApplied(three)).toThrow("ORDER5 can't be combined with TEEHALF.");
        await expect(preview(db, ["A1", "B2", "C3", "D4", "E5", "F6"])).rejects.toThrow("Use up to 5 discount codes.");
    });

    it("says how far a code is from qualifying instead of failing the cart", async () => {
        const db = openStore(provider);
        await live(db, {
            name: "Big order",
            codes: [{ code: "BIG15" }],
            conditions: [{ kind: "minimum_merchandise_subtotal", config: { amountMinor: 400_000, currencyCode: "BDT" } }],
            effects: [orderOff(1_500)],
        });
        await live(db, {
            name: "Three tees",
            codes: [{ code: "TEES" }],
            conditions: [{ kind: "minimum_item_quantity", config: { quantity: 3, productIds: ["prod_tee"] } }],
            effects: [percentOff(1_000, { productIds: ["prod_tee"] })],
        });
        const result = await preview(db, ["BIG15", "TEES", "NOPE"]);
        expect(result.applied).toBeNull();
        expect(result.rejectedCodes).toEqual([
            expect.objectContaining({ code: "BIG15", reason: "minimum_subtotal", shortfallMinor: 80_000, message: "Add ৳800 more to use BIG15." }),
            expect.objectContaining({ code: "TEES", reason: "minimum_quantity", shortfallQuantity: 1, message: "Add 1 more item to use TEES." }),
            expect.objectContaining({ code: "NOPE", reason: "not_found", message: "This discount code is not valid." }),
        ]);
    });

    it("keeps a one-use code pending until the buyer's phone is known", async () => {
        const db = openStore(provider);
        await live(db, { name: "Once", codes: [{ code: "ONCE" }], maxRedemptionsPerCustomer: 1, effects: [orderOff(1_000)] });
        const withoutPhone = await preview(db, ["ONCE"], { customerPhone: null });
        expect(withoutPhone.rejectedCodes).toEqual([
            expect.objectContaining({ code: "ONCE", reason: "needs_phone", requiresCustomerPhone: true }),
        ]);
        expect((await preview(db, ["ONCE"])).discounts).toEqual([expect.objectContaining({ code: "ONCE", amountMinor: 32_000 })]);
    });

    it("lists the automatic Buy X get Y a product counts toward, never code-only ones", async () => {
        const db = openStore(provider);
        const buyGet = (buy: Record<string, unknown>) => [{
            kind: "percentage_off" as const,
            target: "line" as const,
            allocation: "across" as const,
            config: { basisPoints: 10_000, productIds: ["prod_cap"], getQuantity: 1, buy: { quantity: 2, ...buy } },
        }];
        await live(db, { name: "Two tees, free cap", endsAtEpochSeconds: NOW + 86_400, effects: buyGet({ productIds: ["prod_tee"] }) });
        await live(db, { name: "Shoes gift", effects: buyGet({ collectionIds: ["col_shoes"] }) });
        await live(db, { name: "Secret", codes: [{ code: "SECRET" }], effects: buyGet({ productIds: ["prod_tee"] }) });

        const tee = await listProductBuyGetOffers(db, "prod_tee", "BDT", NOW);
        expect(tee).toEqual([expect.objectContaining({
            title: "Two tees, free cap",
            buyQuantity: 2,
            getQuantity: 1,
            basisPoints: 10_000,
            endsAtEpochSeconds: NOW + 86_400,
        })]);
        expect((await listProductBuyGetOffers(db, "prod_boot", "BDT", NOW)).map(({ title }) => title)).toEqual(["Shoes gift"]);
        expect(await listProductBuyGetOffers(db, "prod_cap", "BDT", NOW)).toEqual([]);
    });

    it("names the items a Buy X get Y code still needs, with a one-tap SKU for simple products", async () => {
        const db = openStore(provider);
        sqlite!.exec(`
            INSERT INTO product_variants (id, product_id, sku, price_minor, is_default) VALUES
                ('var_cap', 'prod_cap', 'CAP-1', 20000, 1);
        `);
        await live(db, {
            name: "Tee gets a cap",
            codes: [{ code: "CAPGIFT" }],
            effects: [{
                kind: "percentage_off",
                target: "line",
                allocation: "across",
                config: { basisPoints: 5_000, productIds: ["prod_cap"], getQuantity: 1, buy: { quantity: 2, productIds: ["prod_tee"] } },
            }],
        });
        const teesOnly = await preview(db, ["CAPGIFT"], { cart: { ...cart, lines: [cart.lines[0]!] } });
        expect(teesOnly.rejectedCodes).toEqual([expect.objectContaining({
            code: "CAPGIFT",
            reason: "get_items",
            message: "Add Cap to your cart to get it 50% off.",
            offer: expect.objectContaining({
                kind: "get",
                basisPoints: 5_000,
                products: [{ id: "prod_cap", slug: "cap", name: "Cap", variantId: "var_cap", price: 200 }],
            }),
        })]);
        const oneTee = await preview(db, ["CAPGIFT"], {
            cart: { ...cart, lines: [{ ...cart.lines[0]!, quantity: 1 }] },
        });
        expect(oneTee.rejectedCodes).toEqual([expect.objectContaining({
            reason: "buy_items",
            offer: expect.objectContaining({ kind: "buy", quantity: 1 }),
        })]);
    });
});
