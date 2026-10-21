// A market whose live lists price some SKUs above or below their base: its
// listing orders, filters and bounds by the market's own card prices, the
// ones its cards show. One store and one set of scenarios for D1
// (market-price-order.d1.test.ts) and PostgreSQL
// (market-price-order.postgres-native.test.ts). Test-only.
import { expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { marketCardPrices, readMarketPriceContext, startMarketPricing } from "../price-lists";
import { getStorefrontCategoryProducts, getStorefrontProducts } from "./listing";

const PRODUCTS = 90;
const NOW = 1_800_000_000;

/** Products of one to three SKUs (some sold out), a fixed-price list and a sale list in India, an FX market with a USD list. */
export function marketPriceOrderSeed(): string {
    const products: string[] = [];
    const skus: string[] = [];
    const prices: string[] = [];
    const axes: string[] = [];
    const values: string[] = [];
    const assignments: string[] = [];
    for (let index = 0; index < PRODUCTS; index += 1) {
        const id = `prd_${String(index).padStart(3, "0")}`;
        const base = 10_000 + (index * 53 % 31) * 1_000;
        products.push(`('${id}', 'Product ${index}', ${base}, 'product-${index}', '${index % 2 === 0 ? "cat_even" : "cat_odd"}', 1, ${1_700_000_000 + index})`);
        const skuCount = 1 + (index % 3);
        for (let sku = 0; sku < skuCount; sku += 1) {
            const skuId = `var_${id}_${sku}`;
            const price = base + sku * 4_000;
            const stock = index % 7 === 0 && sku === 0 ? 0 : 5;
            skus.push(`('${skuId}', '${id}', 'SKU-${id}-${sku}', ${price}, ${stock}, ${skuCount === 1 ? 1 : 0}, 1, ${skuCount === 1 ? "NULL" : `'ov_${id}_${sku}'`})`);
            if (skuCount > 1) {
                if (sku === 0) axes.push(`('opt_${id}', '${id}', 'Size', 'size', 0)`);
                values.push(`('ov_${id}_${sku}', 'opt_${id}', 'S${sku}', 's${sku}', ${sku})`);
                assignments.push(`('${skuId}', 'opt_${id}', 'ov_${id}_${sku}')`);
            }
            // India's list prices about half the SKUs, some far below base, some far above.
            if ((index + sku) % 2 === 0) prices.push(`('pl_india', '${skuId}', 'BDT', ${(index * 7919 % 40) * 1_000 + 5_000 + sku * 500})`);
            // The live sale list undercuts a few; the scheduled one is not live yet.
            if (index % 9 === 0) prices.push(`('pl_in_sale', '${skuId}', 'BDT', ${3_000 + sku * 100})`);
            if (index % 5 === 0) prices.push(`('pl_in_later', '${skuId}', 'BDT', 1000)`);
            // The FX market's own-currency list prices a third.
            if (index % 3 === 0) prices.push(`('pl_usa1', '${skuId}', 'USD', ${(index * 31 % 17) * 100 + 900})`);
        }
    }
    return `
        INSERT INTO categories (id, name, slug, status) VALUES ('cat_even', 'Even', 'even', 'published'), ('cat_odd', 'Odd', 'odd', 'published');
        INSERT INTO markets (id, handle, name, status) VALUES ('mkt_in', 'india', 'India', 'active');
        INSERT INTO markets (id, handle, name, status, is_backup, price_mode, fx_rate, price_adjustment_bps, currency_code)
            VALUES ('mkt_us', 'united-states', 'United States', 'active', 0, 'fx', '0.0082', 0, 'USD');
        INSERT INTO market_countries (country_code, market_id) VALUES ('IN', 'mkt_in'), ('US', 'mkt_us');
        INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_in', 'mkt_in', 'subfolder', 'en-in', 'en'), ('mkp_us', 'mkt_us', 'subfolder', 'en-us', 'en');
        INSERT INTO price_lists (id, name, kind, market_id, status, priority) VALUES ('pl_india', 'India', 'market', 'mkt_in', 'active', 0),
            ('pl_usa1', 'United States', 'market', 'mkt_us', 'active', 0);
        INSERT INTO price_lists (id, name, kind, market_id, status, starts_at, ends_at) VALUES
            ('pl_in_sale', 'Sale', 'sale', 'mkt_in', 'active', ${NOW - 3_600}, ${NOW + 3_600}),
            ('pl_in_later', 'Later', 'sale', 'mkt_in', 'active', ${NOW + 7_200}, NULL);
        INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES ${products.join(", ")};
        INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory, option_combination_key) VALUES ${skus.join(", ")};
        INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES ${axes.join(", ")};
        INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES ${values.join(", ")};
        INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES ${assignments.join(", ")};
        INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor) VALUES ${prices.join(", ")}
    `;
}

/** The scenarios, inside the caller's `describe` (the clock stands at NOW: the caller fakes Date). */
export function marketPriceOrderScenarios(setup: () => Promise<{ db: Database }>, clock: { now: number }): void {
    clock.now = NOW;
    const exactOrder = async (db: Database, presence: string, ids?: string[]) => {
        const context = await readMarketPriceContext(db, presence, NOW);
        const all = ids ?? Array.from({ length: PRODUCTS }, (_, index) => `prd_${String(index).padStart(3, "0")}`);
        const prices = await marketCardPrices(db, context, all);
        return { context, prices };
    };

    it.each([["en-in"], ["en-us"]])("orders a %s listing by its market card prices, ascending and descending", async (presence) => {
        const { db } = await setup();
        const { context, prices } = await exactOrder(db, presence);
        expect(context.listed).toBe(true);
        for (const sort of ["price-asc", "price-desc"] as const) {
            const expected = [...prices].sort(([leftId, left], [rightId, right]) =>
                (sort === "price-asc" ? left.amountMinor - right.amountMinor : right.amountMinor - left.amountMinor)
                || (leftId < rightId ? -1 : 1)).map(([id]) => id);
            const seen: string[] = [];
            for (let page = 1; page <= Math.ceil(expected.length / 20); page += 1) {
                const result = await getStorefrontProducts(db, { page, limit: 20, sort }, startMarketPricing(db, presence));
                seen.push(...result.products.map((product) => product.id));
                // The cards show the prices they are ordered by.
                for (const card of result.products) expect(Math.round(card.discountedPrice * 100)).toBe(prices.get(card.id)!.amountMinor);
            }
            expect(seen).toEqual(expected);
        }
    });

    it("filters by the market card's SKU prices and bounds the range by them", async () => {
        const { db } = await setup();
        const { prices } = await exactOrder(db, "en-in");
        const result = await getStorefrontProducts(db, { page: 1, limit: 100 }, startMarketPricing(db, "en-in"));
        const amounts = [...prices.values()];
        expect(result.priceRange).toEqual({
            min: Math.min(...amounts.map((price) => price.amountMinor)) / 100,
            max: Math.max(...amounts.map((price) => price.maxAmountMinor)) / 100,
        });
        // "At most 120": some buyable-pool SKU costs 120 or less, which is exactly a card price of 120 or less.
        const filtered = await getStorefrontProducts(db, { page: 1, limit: 100, maxPrice: 120 }, startMarketPricing(db, "en-in"));
        const expectedIds = [...prices].filter(([, price]) => price.amountMinor <= 12_000).map(([id]) => id).sort();
        expect(filtered.products.map((product) => product.id).sort()).toEqual(expectedIds);
        expect(filtered.pagination.total).toBe(expectedIds.length);
        expect(expectedIds.length).toBeGreaterThan(5);
        expect(expectedIds.length).toBeLessThan(PRODUCTS);
        const categoryPage = await getStorefrontCategoryProducts(db, {
            id: "cat_even", name: "Even", slug: "even", description: null, imageUrl: null, metaTitle: null,
            metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null,
        }, { page: 1, limit: 50, sort: "price-asc" }, { pricing: startMarketPricing(db, "en-in") });
        const even = [...prices].filter(([id]) => Number(id.slice(4)) % 2 === 0)
            .sort(([leftId, left], [rightId, right]) => left.amountMinor - right.amountMinor || (leftId < rightId ? -1 : 1)).map(([id]) => id);
        expect(categoryPage.products.map((product) => product.id)).toEqual(even);
    });
}
