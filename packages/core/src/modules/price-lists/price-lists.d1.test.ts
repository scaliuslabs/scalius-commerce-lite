// Price lists (MARKETS-DESIGN D5) as the dashboard edits them, and checkout
// pricing in the order's market: one revision per list aggregate, prices at
// the market's increment with quantity breaks, the backup market kept at
// base prices for every public list, and the cart, the checkout authority
// and staff orders all priced by `resolvePrice()` (sale > segment > market >
// FX > base) for the buyer and quantity at hand.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { createCustomerSegment, deleteCustomerSegment } from "../customers";
import { updateMarket, getMarket } from "../markets";
import { validateStorefrontCartItems, loadStorefrontCheckoutAuthority } from "../checkout";
import { resolveAdminOrderItemInventory } from "../orders/admin/quote";
import {
    createPriceList,
    deletePriceList,
    getPriceList,
    listPriceLists,
    listPriceListVariants,
    priceListChoices,
    setPriceListPrices,
    updatePriceList,
} from "./price-lists.service";

let sqlite: DatabaseSync;
let db: Database;

beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
        INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
        INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in');
        INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en');
        INSERT INTO products (id, name, slug, price_minor, is_active, discount_type, discount_bps) VALUES
            ('p_tea', 'Tea', 'tea', 50000, 1, 'percentage', 1000),
            ('p_cup', 'Cup', 'cup', 20000, 1, NULL, 0);
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, fulfillment_kind) VALUES
            ('v_tea', 'p_tea', 'TEA-1', 50000, 100, 0, 1, 1, 'physical'),
            ('v_cup', 'p_cup', 'CUP-1', 20000, 100, 0, 1, 1, 'physical');
        INSERT INTO customers (id, name, phone, origin, account_claimed_at, phone_verified_at)
            VALUES ('cust_trade', 'Trader', '+8801712345678', 'account', 1700000000, 1700000000);
        INSERT INTO customer_tag_links (customer_id, tag) VALUES ('cust_trade', 'wholesale');
    `);
});
afterEach(() => sqlite.close());

const line = (variantId: string, quantity = 1) => ({
    productId: variantId === "v_tea" ? "p_tea" : "p_cup",
    variantId,
    quantity,
});
const currency = { currencyCode: "BDT", priceIncrementMinor: 100 };

async function unitPrices(items: ReturnType<typeof line>[], market: NonNullable<Parameters<typeof validateStorefrontCartItems>[2]>["market"]) {
    const result = await validateStorefrontCartItems(db, items, { ...currency, market });
    expect(result.issues).toEqual([]);
    return result.items.map((item) => item.unitPriceMinor);
}

async function activeList(input: Parameters<typeof createPriceList>[1], prices: Parameters<typeof setPriceListPrices>[2]["set"]) {
    const list = await createPriceList(db, { status: "active", ...input });
    return setPriceListPrices(db, list.id, { expectedRevision: list.revision, set: prices });
}

describe("price lists", () => {
    it("keeps market and sale lists off the backup market and checks every field", async () => {
        await expect(createPriceList(db, { name: "Home", kind: "market", marketId: "mkt_backup" })).rejects.toThrow(ValidationError);
        await expect(createPriceList(db, { name: "Home sale", kind: "sale", marketId: "mkt_backup" })).rejects.toThrow(/backup market/);
        await expect(createPriceList(db, { name: "Trade", kind: "segment", marketId: "mkt_backup" })).rejects.toThrow(/segment/);
        await expect(createPriceList(db, { name: "X", kind: "market", marketId: "mkt_in", startsAt: new Date(2_000_000_000_000), endsAt: new Date(1_000_000_000_000) }))
            .rejects.toThrow(/end must be after/);
        await expect(createPriceList(db, { name: "X", kind: "market", marketId: "mkt_missing" })).rejects.toThrow(/market/);

        const segment = await createCustomerSegment(db, { name: "Wholesale", definition: { conditions: [{ field: "tags", op: "has_any", tags: ["wholesale"] }] } }, null);
        // What a new list can price: the backup market first, then the others; every segment.
        expect(await priceListChoices(db)).toEqual({
            markets: [{ id: "mkt_backup", name: expect.any(String), isBackup: true }, { id: "mkt_in", name: "India", isBackup: false }],
            segments: [{ id: segment.id, name: "Wholesale" }],
        });
        const trade = await createPriceList(db, { name: "Trade", kind: "segment", marketId: "mkt_backup", segmentId: segment.id });
        expect(trade).toMatchObject({ kind: "segment", marketIsBackup: true, segmentName: "Wholesale", status: "draft", state: "draft", revision: 1, currencyCode: "BDT", priceIncrementMinor: 100 });
        // The segment stays while a price list prices it.
        await expect(deleteCustomerSegment(db, segment.id)).rejects.toThrow(ConflictError);

        const sale = await createPriceList(db, { name: "Eid sale", kind: "sale", marketId: "mkt_in", status: "active", startsAt: new Date(Date.now() + 86_400_000) });
        expect(sale.state).toBe("scheduled");
        expect((await listPriceLists(db)).map((list) => list.name)).toEqual(["Eid sale", "Trade"]);
        expect((await listPriceLists(db, { marketId: "mkt_in" })).map((list) => list.name)).toEqual(["Eid sale"]);

        const updated = await updatePriceList(db, sale.id, { expectedRevision: 1, name: "Eid sale 2026", priority: 5, startsAt: null });
        expect(updated).toMatchObject({ name: "Eid sale 2026", priority: 5, state: "active", revision: 2 });
        await expect(updatePriceList(db, sale.id, { expectedRevision: 1, name: "Stale" })).rejects.toThrow(ConflictError);
        await expect(updatePriceList(db, sale.id, { expectedRevision: 2, marketId: "mkt_backup" })).rejects.toThrow(/backup market/);
        await deletePriceList(db, sale.id, 2);
        await expect(getPriceList(db, sale.id)).rejects.toThrow(/not found/);
    });

    it("sets prices at the increment with quantity breaks and lists them per SKU", async () => {
        const list = await createPriceList(db, { name: "India", kind: "market", marketId: "mkt_in" });
        await expect(setPriceListPrices(db, list.id, { expectedRevision: 1, set: [{ variantId: "v_tea", prices: [{ amount: 410.5 }] }] }))
            .rejects.toThrow(/whole numbers/);
        await expect(setPriceListPrices(db, list.id, { expectedRevision: 1, set: [{ variantId: "v_tea", prices: [{ amount: 400, minQuantity: 10 }] }] }))
            .rejects.toThrow(/price for 1 unit/);
        await expect(setPriceListPrices(db, list.id, { expectedRevision: 1, set: [{ variantId: "v_tea", prices: [{ amount: 400, compareAt: 400 }] }] }))
            .rejects.toThrow(/compare-at/);
        await expect(setPriceListPrices(db, list.id, { expectedRevision: 1, set: [{ variantId: "v_missing", prices: [{ amount: 400 }] }] }))
            .rejects.toThrow(/no longer exists/);
        const saved = await setPriceListPrices(db, list.id, {
            expectedRevision: 1,
            set: [
                { variantId: "v_tea", prices: [{ amount: 420, compareAt: 520 }, { amount: 400, minQuantity: 10 }] },
                { variantId: "v_cup", prices: [{ amount: 180 }] },
            ],
        });
        expect(saved).toMatchObject({ revision: 2, priceCount: 3, variantCount: 2 });
        await expect(setPriceListPrices(db, list.id, { expectedRevision: 1, remove: ["v_cup"] })).rejects.toThrow(ConflictError);
        const page = await listPriceListVariants(db, list.id, { search: "tea" });
        expect(page).toMatchObject({ total: 1, page: 1 });
        expect(page.items[0]).toEqual({
            variantId: "v_tea",
            productId: "p_tea",
            productName: "Tea",
            variantLabel: null,
            sku: "TEA-1",
            basePriceMinor: 50000,
            prices: [
                { currencyCode: "BDT", amountMinor: 42000, compareAtMinor: 52000, minQuantity: 1 },
                { currencyCode: "BDT", amountMinor: 40000, compareAtMinor: null, minQuantity: 10 },
            ],
        });
        const removed = await setPriceListPrices(db, list.id, { expectedRevision: 2, remove: ["v_cup"] });
        expect(removed).toMatchObject({ revision: 3, priceCount: 2, variantCount: 1 });
    });
});

describe("checkout prices in the order's market", () => {
    it("prices the cart page by the presence and the order by its country", async () => {
        await activeList({ name: "India", kind: "market", marketId: "mkt_in" }, [
            { variantId: "v_tea", prices: [{ amount: 420 }, { amount: 400, minQuantity: 10 }] },
        ]);
        // The backup market and a buyer abroad elsewhere pay the base price after the product discount.
        expect(await unitPrices([line("v_tea"), line("v_cup")], {})).toEqual([45000, 20000]);
        expect(await unitPrices([line("v_tea")], { placing: true, shippingCountryCode: "BD" })).toEqual([45000]);
        // The India presence and an order shipping to India pay its list price.
        expect(await unitPrices([line("v_tea"), line("v_cup")], { presence: "en-in" })).toEqual([42000, 20000]);
        expect(await unitPrices([line("v_tea")], { placing: true, shippingCountryCode: "IN" })).toEqual([42000]);
        // Quantity breaks count the SKU across the cart's lines.
        expect(await unitPrices([line("v_tea", 6), line("v_tea", 4)], { presence: "en-in" })).toEqual([40000, 40000]);
        // An order with nothing physical is priced where it is billed.
        sqlite.exec("UPDATE product_variants SET fulfillment_kind = 'service' WHERE id = 'v_tea'");
        expect(await unitPrices([line("v_tea")], { placing: true, shippingCountryCode: "BD", billingCountryCode: "IN" })).toEqual([42000]);
    });

    it("derives an FX market's prices and lets a list win over them", async () => {
        const market = await getMarket(db, "mkt_in");
        await updateMarket(db, "mkt_in", { expectedRevision: market.revision, priceMode: "fx", priceAdjustmentBps: 1_000, priceRoundingMinor: 1_000, priceEndingMinor: 900 });
        // 450 + 10 % = 495 → up to 500 → ends in 9: 499; 200 + 10 % = 220 → 219.
        expect(await unitPrices([line("v_tea"), line("v_cup")], { presence: "en-in" })).toEqual([49900, 21900]);
        await activeList({ name: "Cups", kind: "market", marketId: "mkt_in" }, [{ variantId: "v_cup", prices: [{ amount: 150 }] }]);
        expect(await unitPrices([line("v_tea"), line("v_cup")], { presence: "en-in" })).toEqual([49900, 15000]);
        await expect(updateMarket(db, "mkt_backup", { expectedRevision: 1, priceMode: "fx" })).rejects.toThrow(/backup market/);
        await expect(updateMarket(db, "mkt_in", { expectedRevision: market.revision + 1, fxRate: "1.5" })).rejects.toThrow(/exchange rate is 1/);
        await expect(updateMarket(db, "mkt_in", { expectedRevision: market.revision + 1, priceEndingMinor: 950 })).rejects.toThrow(/ending/);
    });

    it("gives a segment's signed-in members their list price, and a live sale wins over it", async () => {
        const segment = await createCustomerSegment(db, { name: "Wholesale", definition: { conditions: [{ field: "tags", op: "has_any", tags: ["wholesale"] }] } }, null);
        await activeList({ name: "Trade", kind: "segment", marketId: "mkt_backup", segmentId: segment.id }, [
            { variantId: "v_tea", prices: [{ amount: 350 }] },
        ]);
        expect(await unitPrices([line("v_tea")], { placing: true, shippingCountryCode: "BD" })).toEqual([45000]);
        expect(await unitPrices([line("v_tea")], { placing: true, shippingCountryCode: "BD", customerId: "cust_trade" })).toEqual([35000]);
        // Membership is read only when it is awaited.
        let asked = 0;
        const lazy = { then: (resolve: (value: string | null) => unknown) => { asked += 1; return Promise.resolve("cust_trade").then(resolve); } } as PromiseLike<string | null>;
        expect(await unitPrices([line("v_cup")], { placing: true, shippingCountryCode: "BD", customerId: lazy })).toEqual([20000]);
        expect(asked).toBe(0);
        // Another market's buyer never gets it.
        expect(await unitPrices([line("v_tea")], { placing: true, shippingCountryCode: "IN", customerId: "cust_trade" })).toEqual([45000]);
        // A sale in India: a scheduled one waits for its start.
        const sale = await activeList({ name: "Sale", kind: "sale", marketId: "mkt_in", startsAt: new Date(Date.now() + 3_600_000) }, [
            { variantId: "v_tea", prices: [{ amount: 300 }] },
        ]);
        expect(await unitPrices([line("v_tea")], { presence: "en-in" })).toEqual([45000]);
        await updatePriceList(db, sale.id, { expectedRevision: sale.revision, startsAt: null });
        expect(await unitPrices([line("v_tea")], { presence: "en-in" })).toEqual([30000]);
    });

    it("prices the checkout authority and staff orders in the order's market", async () => {
        await activeList({ name: "India", kind: "market", marketId: "mkt_in" }, [{ variantId: "v_cup", prices: [{ amount: 170 }] }]);
        // A service line ships nothing: the order is priced (and placed) where it is billed.
        sqlite.exec("UPDATE product_variants SET fulfillment_kind = 'service' WHERE id = 'v_cup'");
        const authority = async (billingCountryCode: string) => (await loadStorefrontCheckoutAuthority(db, {
            items: [{ ...line("v_cup"), price: undefined }],
            billingCountryCode,
            customerPhone: "+8801712345678",
        })).cartValidation.items.map((item) => item.unitPriceMinor);
        expect(await authority("IN")).toEqual([17000]);
        expect(await authority("BD")).toEqual([20000]);
        sqlite.exec("UPDATE product_variants SET fulfillment_kind = 'physical' WHERE id = 'v_cup'");
        const staff = async (shippingCountryCode: string | null) => (await resolveAdminOrderItemInventory(db, [{ ...line("v_cup") }], { shippingCountryCode }))
            .map((item) => item.catalogUnitPriceMinor);
        expect(await staff("IN")).toEqual([17000]);
        expect(await staff("BD")).toEqual([20000]);
        expect((await resolveAdminOrderItemInventory(db, [{ ...line("v_cup") }])).map((item) => item.catalogUnitPriceMinor)).toEqual([20000]);
    });
});
