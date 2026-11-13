// Test-only: a randomised catalogue for the narrowed facet scopes
// (facets-live.oracle.d1.test.ts, apps/api/src/facets-rows-read.test.ts):
// categories with a draft child, published and draft brands, every attribute
// type (and a non-filterable, a legacy "brand" and a deleted one), option
// SKUs on two axes, hidden, archived, unpriced and out-of-stock products,
// stock held only where the online store does not sell, and review stats.
import type { DatabaseSync } from "node:sqlite";
import type { MarketPricing } from "../price-lists";

export function rng(seed: number) {
    let state = seed;
    return (n: number) => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return Math.floor(state / 65_536) % n; };
}

export const CATEGORIES = [
    { id: "cat_root", slug: "root", parent: null, status: "published" },
    { id: "cat_a", slug: "a", parent: "cat_root", status: "published" },
    { id: "cat_b", slug: "b", parent: "cat_root", status: "published" },
    { id: "cat_c", slug: "c", parent: "cat_a", status: "published" },
    { id: "cat_draft", slug: "draft", parent: "cat_root", status: "draft" },
    { id: "cat_loose", slug: "loose", parent: null, status: "published" },
] as const;
const COLORS = ["red", "blue", "green", "black"];
const MATERIALS = ["linen", "silk", "cotton"];
const SIZES = ["s", "m", "l"];
const SHADES = ["chalk", "navy"];

export function seedCatalogue(s: DatabaseSync, seed: number, size: number, options: { reviewsOff?: boolean; crowd?: string } = {}): void {
    const random = rng(seed);
    for (const category of CATEGORIES) {
        s.prepare("INSERT INTO categories (id, name, slug, status, parent_id) VALUES (?, ?, ?, ?, ?)")
            .run(category.id, category.slug.toUpperCase(), category.slug, category.status, category.parent);
    }
    s.exec(`
        INSERT INTO brands (id, name, slug, status, sort_order) VALUES
            ('brd_one00001', 'One', 'one', 'published', 2), ('brd_two00001', 'Two', 'two', 'published', 1),
            ('brd_draft001', 'Draft', 'draftbrand', 'draft', 0);
        INSERT INTO product_attributes (id, name, slug, filterable, value_type, unit, facet_display, sort_order) VALUES
            ('attr_color', 'Colour', 'color', 1, 'enum', NULL, 'swatch', 2),
            ('attr_material', 'Material', 'material', 1, 'text', NULL, 'checkbox', 1),
            ('attr_screen', 'Screen', 'screen', 1, 'number', 'in', 'range', 3),
            ('attr_wifi', 'Wi-Fi', 'wifi', 1, 'boolean', NULL, 'checkbox', 4),
            ('attr_hidden', 'Hidden', 'hidden', 0, 'text', NULL, 'checkbox', 5),
            ('attr_legacy', 'Legacy brand', 'brand', 1, 'text', NULL, 'checkbox', 6),
            ('attr_gone', 'Gone', 'gone', 1, 'text', NULL, 'checkbox', 7);
        INSERT INTO attribute_values (id, attribute_id, value, normalized_value, sort_order, swatch_hex) VALUES
            ('atv_color_red', 'attr_color', 'Red', 'red', 3, '#ff0000'), ('atv_color_blue', 'attr_color', 'Blue', 'blue', 1, '#0000ff'),
            ('atv_color_green', 'attr_color', 'Green', 'green', 2, NULL), ('atv_color_black', 'attr_color', 'Black', 'black', 0, '#000000');
        INSERT INTO category_attribute_sets (category_id, attribute_id, sort_order) VALUES
            ('cat_a', 'attr_screen', 0), ('cat_a', 'attr_color', 1), ('cat_root', 'attr_material', 0);
        INSERT INTO inventory_locations (id, name, code) VALUES ('loc_far', 'Far', 'FAR');
        DELETE FROM sales_channel_locations WHERE channel_id = 'sc_online_store' AND location_id = 'loc_far';
    `);
    if (options.reviewsOff) {
        s.exec(`INSERT INTO settings (id, key, value, type, category) VALUES ('reviews_doc', 'document', '{"enabled":false}', 'json', 'reviews')`);
    }
    const categoryIds = CATEGORIES.map((category) => category.id);
    for (let index = 0; index < size; index += 1) {
        const id = `p_${String(index).padStart(4, "0")}`;
        const price = [0, 50_000, 120_000, 180_000, 250_000, 400_000][random(6)]!;
        const category = options.crowd && random(4) !== 0 ? options.crowd : random(7) === 0 ? null : categoryIds[random(categoryIds.length)]!;
        const brand = [null, "brd_one00001", "brd_two00001", "brd_draft001"][random(4)] ?? null;
        const createdAt = 1_700_000_000 + random(40) * 3_600;
        const active = random(12) === 0 ? 0 : 1;
        const deletedAt = random(15) === 0 ? 1_700_100_000 : null;
        const discount = random(4) === 0;
        s.prepare(`INSERT INTO products (id, name, price_minor, slug, category_id, brand_id, is_active, deleted_at, created_at,
                free_delivery, discount_type, discount_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'percentage', ?)`)
            .run(id, `${MATERIALS[random(3)]} ${["panjabi", "shirt", "bag"][random(3)]} ${index}`, price, id, category, brand,
                active, deletedAt, createdAt, 0, discount ? 1_500 : 0);
        const tracked = random(5) === 0 ? 0 : 1;
        let reviewSku: string | null = null;
        if (random(4) === 0) {
            // A product with option SKUs: size by shade, some out of stock, one retired.
            s.prepare("INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position) VALUES (?, ?, 'Size', 'size', 0), (?, ?, ?, 'shade', 1)")
                .run(`opt_size_${id}`, id, `opt_shade_${id}`, id, random(2) === 0 ? "Shade" : "shade");
            SIZES.forEach((value, position) => s.prepare("INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES (?, ?, ?, ?, ?)")
                .run(`ov_${value}_${id}`, `opt_size_${id}`, value.toUpperCase(), value, position));
            SHADES.forEach((value, position) => s.prepare("INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position) VALUES (?, ?, ?, ?, ?)")
                .run(`ov_${value}_${id}`, `opt_shade_${id}`, value, value, position));
            for (const sizeValue of SIZES) {
                for (const shade of SHADES) {
                    if (random(3) === 0) continue;
                    const sku = `var_${id}_${sizeValue}_${shade}`;
                    reviewSku ??= sku;
                    s.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory,
                            option_combination_key, deleted_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`)
                        .run(sku, id, sku, price + random(3) * 10_000, random(3) === 0 ? 0 : 4, tracked, `${sizeValue}|${shade}`, random(10) === 0 ? 1_700_100_000 : null);
                    s.prepare("INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES (?, ?, ?), (?, ?, ?)")
                        .run(sku, `opt_size_${id}`, `ov_${sizeValue}_${id}`, sku, `opt_shade_${id}`, `ov_${shade}_${id}`);
                    if (random(4) === 0) s.prepare("INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES (?, 'loc_far', ?)").run(sku, 4);
                }
            }
        } else if (random(10) !== 0) {
            const sku = `var_${id}`;
            reviewSku = sku;
            s.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(sku, id, sku, price, random(4) === 0 ? 0 : 3, random(5) === 0 ? 1 : 0, tracked);
            // Stock held only at a location the online store does not sell from.
            if (random(5) === 0) s.prepare("INSERT INTO inventory_levels (variant_id, location_id, on_hand) VALUES (?, 'loc_far', ?)").run(sku, 3);
        }
        const attribute = (attributeId: string, value: string, valueId: string | null, valueNumber: number | null) => s.prepare(
            "INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id, value_number) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(`pav_${attributeId}_${id}`, id, attributeId, value, valueId, valueNumber);
        if (random(4) !== 0) { const color = COLORS[random(COLORS.length)]!; attribute("attr_color", color, `atv_color_${color}`, null); }
        if (random(3) !== 0) attribute("attr_material", ` ${MATERIALS[random(3)]!.toUpperCase()} `, null, null);
        if (random(2) === 0) { const inches = [13.3, 14, 15.6, 17][random(4)]!; attribute("attr_screen", `${inches} in`, null, inches); }
        if (random(3) === 0) { const on = random(2); attribute("attr_wifi", on ? "Yes" : "No", null, on); }
        if (random(5) === 0) attribute("attr_hidden", "secret", null, null);
        if (random(5) === 0) attribute("attr_legacy", "acme", null, null);
        if (random(5) === 0) attribute("attr_gone", "old", null, null);
        // Ratings arrive as a store gets them: a published review of a
        // fulfilled line of a delivered order, which the review triggers count.
        if (reviewSku && random(3) === 0) {
            for (let review = 0; review < 1 + random(3); review += 1) {
                const key = `${id.slice(2)}_${review}`;
                s.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, status)
                    VALUES (?, 'Buyer', '01700000000', 'House 1', 'c', 'z', ?, 'confirmed')`).run(`ord_${key}`, price);
                s.prepare(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, fulfillment_type)
                    VALUES (?, ?, ?, ?, 1, ?, 'ship')`).run(`item_${key}`, `ord_${key}`, id, reviewSku, price);
                s.prepare("INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type) VALUES (?, ?, 'ship', ?, 'admin')")
                    .run(`ful_${key}`, `ord_${key}`, `key_${key}`);
                s.prepare("INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity) VALUES (?, ?, ?, ?, 1)")
                    .run(`fln_${key}`, `ful_${key}`, `ord_${key}`, `item_${key}`);
                s.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(`ord_${key}`);
                s.prepare(`INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type,
                        author_display_name, rating, status, published_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'customer', 'Buyer B.', ?, 'published', 1790000000)`)
                    .run(`rev_facets_${key}`, id, reviewSku, `ord_${key}`, `item_${key}`, `cus_${key}`, 1 + random(5));
            }
        }
    }
}

export const KWD: MarketPricing = {
    presence: "en-kw",
    context: Promise.resolve({
        marketId: "mkt_kuwait", currencyCode: "KWD", decimalPlaces: 3, incrementMinor: 1,
        shopCurrencyCode: "BDT", shopIncrementMinor: 100, listed: false, money: null, atSeconds: 1,
        fx: { policy: { rate: "0.0025", adjustmentBps: 0, roundingMinor: null, endingMinor: null }, fromDecimalPlaces: 2, toDecimalPlaces: 3, incrementMinor: 1 },
    }),
} as MarketPricing;

/** A market priced by live lists (none hold prices here): its price filter reads the lists per SKU. */
export const LISTED: MarketPricing = {
    presence: "en-kw",
    context: Promise.resolve({
        marketId: "mkt_listed", currencyCode: "KWD", decimalPlaces: 3, incrementMinor: 5,
        shopCurrencyCode: "BDT", shopIncrementMinor: 100, listed: true, money: null, atSeconds: 1,
        fx: { policy: { rate: "0.0025", adjustmentBps: 0, roundingMinor: null, endingMinor: null }, fromDecimalPlaces: 2, toDecimalPlaces: 3, incrementMinor: 5 },
    }),
} as MarketPricing;

const SORTS = ["newest", "price-asc", "price-desc", "name-asc", "discount", "rating"] as const;

/** A random request: query parameters for the attribute filters, and the listing's own parameters. */
export function randomRequest(random: (n: number) => number) {
    const query: Record<string, string | string[]> = {};
    const pick = <T,>(values: readonly T[]) => values[random(values.length)]!;
    if (random(3) === 0) query.color = random(2) === 0 ? pick(COLORS) : [pick(COLORS), pick(COLORS), "purple"];
    if (random(4) === 0) query.material = pick(MATERIALS);
    if (random(4) === 0) query[random(2) === 0 ? "screen.min" : "screen.max"] = String(pick([14, 15.6]));
    if (random(5) === 0) query.screen = "15.6";
    if (random(5) === 0) query.wifi = pick(["yes", "no"]);
    if (random(4) === 0) query["option.size"] = random(2) === 0 ? pick(SIZES) : [pick(SIZES), pick(SIZES)];
    if (random(4) === 0) query["option.shade"] = pick(SHADES);
    if (random(4) === 0) query.brand = random(2) === 0 ? "one" : ["one", "two", "draftbrand"];
    if (random(6) === 0) query.gone = "old";
    const params = {
        page: 1,
        limit: 20,
        sort: pick(SORTS),
        ...(random(2) === 0 ? { minPrice: pick([0, 500, 1_200]) } : {}),
        ...(random(2) === 0 ? { maxPrice: pick([1_000, 2_000, 5_000]) } : {}),
        ...(random(4) === 0 ? { minRating: pick([1, 2, 3, 4]) } : {}),
        ...(random(5) === 0 ? { hasDiscount: "true" as const } : {}),
        ...(random(6) === 0 ? { freeDelivery: "true" as const } : {}),
        ...(random(5) === 0 ? { inStock: "true" as const } : {}),
    };
    return { query, params, market: [KWD, LISTED, null, null, null, null][random(6)]! };
}

/** A market priced by live lists that hold prices (seedMarketLists): its price order and range read the lists. */
export const LISTED_LIVE: MarketPricing = {
    presence: "en-kw",
    context: Promise.resolve({
        marketId: "mkt_listed", currencyCode: "KWD", decimalPlaces: 3, incrementMinor: 5,
        shopCurrencyCode: "BDT", shopIncrementMinor: 100, listed: true, money: null, atSeconds: 1_750_000_000,
        fx: { policy: { rate: "0.0025", adjustmentBps: 0, roundingMinor: null, endingMinor: null }, fromDecimalPlaces: 2, toDecimalPlaces: 3, incrementMinor: 5 },
    }),
} as MarketPricing;

/**
 * Price lists for LISTED_LIVE's market (market, sale, override, a future and
 * a draft list, another market's list, prices in another currency and for
 * two units), and stock at a location the online store sells from.
 */
export function seedMarketLists(s: DatabaseSync, seed: number): void {
    const random = rng(seed * 97 + 5);
    s.exec(`
        INSERT INTO markets (id, handle, name, status) VALUES ('mkt_listed', 'listed', 'Listed', 'active'), ('mkt_other', 'other', 'Other', 'active');
        INSERT INTO price_lists (id, name, kind, market_id, status, starts_at, ends_at, priority) VALUES
            ('pl_mk1', 'M1', 'market', 'mkt_listed', 'active', NULL, NULL, 1),
            ('pl_mk2', 'M2', 'market', 'mkt_listed', 'active', NULL, NULL, 5),
            ('pl_sale', 'S', 'sale', 'mkt_listed', 'active', 1700000000, 1800000000, 0),
            ('pl_sale_old', 'SO', 'sale', 'mkt_listed', 'active', 1600000000, 1700000000, 0),
            ('pl_ovr', 'O', 'override', 'mkt_listed', 'active', NULL, NULL, 0),
            ('pl_future', 'F', 'override', 'mkt_listed', 'active', 1760000000, NULL, 0),
            ('pl_draft', 'D', 'market', 'mkt_listed', 'draft', NULL, NULL, 9),
            ('pl_other', 'X', 'market', 'mkt_other', 'active', NULL, NULL, 0);
        INSERT INTO inventory_locations (id, name, code) VALUES ('loc_near', 'Near', 'NEAR');
        INSERT OR IGNORE INTO sales_channel_locations (channel_id, location_id) VALUES ('sc_online_store', 'loc_near');
    `);
    const lists = ["pl_mk1", "pl_mk2", "pl_sale", "pl_sale_old", "pl_ovr", "pl_future", "pl_draft", "pl_other"];
    const price = s.prepare(`INSERT INTO price_list_prices (price_list_id, variant_id, currency_code, amount_minor, compare_at_minor, min_quantity)
        VALUES (?, ?, ?, ?, ?, ?)`);
    const stock = s.prepare("INSERT OR IGNORE INTO inventory_levels (variant_id, location_id, on_hand) VALUES (?, 'loc_near', ?)");
    for (const { id } of s.prepare("SELECT id FROM product_variants ORDER BY id").all() as Array<{ id: string }>) {
        for (const list of lists) {
            if (random(4) !== 0) continue;
            const amount = [500, 1_000, 1_200, 2_000, 3_000, 4_999, 5_000, 6_000][random(8)]!;
            price.run(list, id, random(6) === 0 ? "USD" : "KWD", amount, random(3) === 0 ? amount + 700 : null, random(7) === 0 ? 2 : 1);
        }
        if (random(4) === 0) stock.run(id, random(3));
    }
}
