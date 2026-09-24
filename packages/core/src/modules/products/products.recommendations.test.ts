import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { beforeEach, describe, expect, it } from "vitest";

import {
    getStorefrontProductRecommendations,
    MAX_RECOMMENDATION_SOURCE_IDS,
} from "./products.recommendations";
import { getStorefrontProductBySlug } from "./products.storefront";

let sqlite: DatabaseSync;
let db: Database;
let statements: string[];
let statementParams: Array<readonly SQLInputValue[]>;
let maxBoundParameters: number;
const NOW = Math.floor(Date.now() / 1000);

function category(id: string, status: "draft" | "published" | "internal" = "published"): void {
    sqlite.prepare("INSERT INTO categories (id, name, slug, status) VALUES (?, ?, ?, ?)").run(id, id, id, status);
}

function product(input: {
    id: string;
    categoryId?: string | null;
    priceMinor?: number;
    stock?: number;
    createdAt?: number;
    isActive?: boolean;
    photos?: number;
}): void {
    const createdAt = input.createdAt ?? NOW - 86_400;
    const priceMinor = input.priceMinor ?? 100_000;
    sqlite.prepare(
        `INSERT INTO products (id, name, description, price_minor, category_id, slug, is_active, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, `Product ${input.id}`, priceMinor, input.categoryId ?? null, input.id, input.isActive === false ? 0 : 1, createdAt, createdAt);
    sqlite.prepare(
        `INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
    ).run(`var_${input.id}`, input.id, `SKU-${input.id}`, priceMinor, input.stock ?? 5);
    for (let index = 0; index < (input.photos ?? 1); index += 1) {
        const mediaId = `media_${input.id}_${index}`;
        sqlite.prepare(
            `INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
             VALUES (?, ?, 'image', ?, 1, 'image/jpeg', ?, 'ready')`,
        ).run(mediaId, mediaId, `products/${mediaId}.jpg`, `Photo ${index}`);
        sqlite.prepare(
            `INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order)
             VALUES (?, ?, ?, ?, ?)`,
        ).run(`pmed_${input.id}_${index}`, input.id, mediaId, index === 0 ? 1 : 0, index);
    }
}

let orderSequence = 0;
function order(phone: string, productIds: string[], status = "confirmed", createdAt = NOW - 3_600): void {
    orderSequence += 1;
    const orderId = `ord_${orderSequence}`;
    sqlite.prepare(
        `INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, created_at, updated_at)
         VALUES (?, 'Buyer', ?, 'Road 1', 'city', 'zone', ?, ?, ?)`,
    ).run(orderId, phone, status, createdAt, createdAt);
    productIds.forEach((productId, index) => {
        sqlite.prepare(
            "INSERT INTO order_items (id, order_id, product_id, quantity) VALUES (?, ?, ?, 1)",
        ).run(`${orderId}_line_${index}`, orderId, productId);
    });
}

function collection(id: string, config: Record<string, unknown>, isActive = true): void {
    sqlite.prepare(
        "INSERT INTO collections (id, name, presentation, config, is_active) VALUES (?, ?, 'grid', ?, ?)",
    ).run(id, id, JSON.stringify(config), isActive ? 1 : 0);
}

function attribute(productId: string, attributeId: string, value: string): void {
    sqlite.prepare(
        "INSERT OR IGNORE INTO product_attributes (id, name, slug, filterable) VALUES (?, ?, ?, 1)",
    ).run(attributeId, attributeId, attributeId);
    sqlite.prepare(
        "INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES (?, ?, ?, ?)",
    ).run(`pav_${productId}_${attributeId}`, productId, attributeId, value);
}

async function recommend(productIds: string[], limit = 12) {
    statements = [];
    statementParams = [];
    return getStorefrontProductRecommendations(db, { productIds, limit });
}

const ids = (result: { products: Array<{ id: string }> }) => result.products.map((item) => item.id);

beforeEach(() => {
    statements = [];
    statementParams = [];
    maxBoundParameters = 0;
    orderSequence = 0;
    ({ sqlite, db } = createSqliteD1Database({
        onQuery(query, params) {
            statements.push(query);
            statementParams.push(params);
            maxBoundParameters = Math.max(maxBoundParameters, params.length);
            if (params.length > 100) throw new Error(`D1 bound-parameter limit exceeded: ${params.length}`);
        },
    }));
    category("cat_shirts");
    category("cat_trousers");
    category("cat_hidden", "draft");
});

describe("product recommendations", () => {
    it("ranks category, collection and attribute matches above price-only and unrelated products", async () => {
        product({ id: "source", categoryId: "cat_shirts", priceMinor: 100_000 });
        attribute("source", "attr_colour", "Red");
        product({ id: "same_category_same_colour", categoryId: "cat_shirts", priceMinor: 100_000, createdAt: NOW - 50 });
        attribute("same_category_same_colour", "attr_colour", "Red");
        product({ id: "same_category", categoryId: "cat_shirts", priceMinor: 120_000, createdAt: NOW - 40 });
        product({ id: "same_collection", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 30 });
        product({ id: "similar_price", categoryId: "cat_trousers", priceMinor: 110_000, createdAt: NOW - 20 });
        product({ id: "unrelated_newest", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 10 });
        product({ id: "unrelated_older", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 100 });
        product({ id: "sold_out", categoryId: "cat_shirts", priceMinor: 100_000, stock: 0 });
        product({ id: "inactive", categoryId: "cat_shirts", priceMinor: 100_000, isActive: false });
        collection("col_summer", { source: "manual", productIds: ["source", "same_collection"] });
        collection("col_off", { source: "manual", productIds: ["source", "unrelated_older"] }, false);

        const result = await recommend(["source"]);

        expect(ids(result)).toEqual([
            "same_category_same_colour",
            "same_category",
            "same_collection",
            "similar_price",
            "unrelated_newest",
            "unrelated_older",
        ]);
        expect(result.reason).toBe("similar");
        expect(result.products[0]).toMatchObject({
            name: "Product same_category_same_colour",
            price: 1000,
            discountedPrice: 1000,
            priceVaries: false,
            availableForSale: true,
            hasVariants: false,
            imageUrl: expect.stringContaining("media_same_category_same_colour_0"),
            imageAlt: "Photo 0",
            secondaryImageUrl: null,
        });
        expect(statements).toHaveLength(2);
    });

    it("treats products in the same dynamic collection as related, but only through published categories", async () => {
        product({ id: "source", categoryId: "cat_shirts", priceMinor: 100_000 });
        product({ id: "sibling_category", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 100 });
        product({ id: "draft_category", categoryId: "cat_hidden", priceMinor: 900_000, createdAt: NOW - 10 });
        collection("col_menswear", { source: "dynamic", categoryIds: ["cat_shirts", "cat_trousers", "cat_hidden"] });
        // A malformed or partial config is ignored rather than failing the read.
        sqlite.exec(`INSERT INTO collections (id, name, presentation, config, is_active) VALUES
            ('col_broken', 'Broken', 'grid', 'not json', 1),
            ('col_partial', 'Partial', 'grid', '{"source":"manual"}', 1)`);

        expect(ids(await recommend(["source"]))).toEqual(["sibling_category", "draft_category"]);
    });

    it("puts products bought together by two different buyers first and only then says 'also bought'", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "same_category", categoryId: "cat_shirts", createdAt: NOW - 10 });
        product({ id: "belt", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 500 });

        // One buyer twice, plus cancelled and unfinished orders, is not enough evidence.
        order("01711111111", ["source", "belt"]);
        order("01711111111", ["source", "belt"], "delivered");
        order("01722222222", ["source", "belt"], "cancelled");
        order("01733333333", ["source", "belt"], "incomplete");
        const thin = await recommend(["source"], 2);
        expect(thin.reason).toBe("similar");
        expect(ids(thin)).toEqual(["same_category", "belt"]);

        order("01744444444", ["source", "belt"], "pending");
        const evidenced = await recommend(["source"], 2);
        expect(ids(evidenced)).toEqual(["belt", "same_category"]);
        expect(evidenced.reason).toBe("also_bought");

        const wider = await recommend(["source"], 3);
        expect(wider.products).toHaveLength(2);
        expect(wider.reason).toBe("also_bought");
    });

    it("recommends for a whole cart, excluding every cart item", async () => {
        product({ id: "shirt", categoryId: "cat_shirts" });
        product({ id: "trouser", categoryId: "cat_trousers" });
        product({ id: "other_shirt", categoryId: "cat_shirts", createdAt: NOW - 10 });
        product({ id: "other_trouser", categoryId: "cat_trousers", createdAt: NOW - 20 });

        const result = await recommend(["shirt", "trouser"]);
        expect(ids(result)).toEqual(["other_shirt", "other_trouser"]);
        expect(result.reason).toBe("similar");
    });

    it("without source products shows the newest, then popular products once there are enough recent buyers", async () => {
        product({ id: "old_bestseller", createdAt: NOW - 90_000, photos: 2 });
        product({ id: "newest", createdAt: NOW - 10 });
        product({ id: "newer", createdAt: NOW - 20 });

        const fresh = await recommend([], 2);
        expect(fresh.reason).toBe("new_arrivals");
        expect(ids(fresh)).toEqual(["newest", "newer"]);

        // Old sales are outside the 30-day popularity window.
        order("01711111111", ["old_bestseller"], "delivered", NOW - 40 * 86_400);
        order("01722222222", ["old_bestseller"], "delivered", NOW - 40 * 86_400);
        expect((await recommend([], 2)).reason).toBe("new_arrivals");

        order("01733333333", ["old_bestseller"]);
        order("01744444444", ["old_bestseller"]);
        const popular = await recommend([], 2);
        expect(popular.reason).toBe("popular");
        expect(ids(popular)).toEqual(["old_bestseller", "newest"]);
        expect(popular.products[0]?.secondaryImageUrl).toContain("media_old_bestseller_1");
    });

    it("fills with the store's newest products when nothing is related", async () => {
        product({ id: "source", categoryId: "cat_shirts", priceMinor: 100_000 });
        product({ id: "far_newest", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 10 });
        product({ id: "far_older", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 20 });

        const result = await recommend(["source"]);
        expect(ids(result)).toEqual(["far_newest", "far_older"]);
        expect(result.reason).toBe("similar");
    });

    it("breaks ties deterministically by id", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        for (const id of ["tie_c", "tie_a", "tie_b"]) {
            product({ id, categoryId: "cat_shirts", createdAt: NOW - 10 });
        }
        expect(ids(await recommend(["source"]))).toEqual(["tie_a", "tie_b", "tie_c"]);
        expect(ids(await recommend(["source"]))).toEqual(["tie_a", "tie_b", "tie_c"]);
    });

    it("keeps bound parameters constant for many source ids and caps the source list", async () => {
        const many = Array.from({ length: 60 }, (_, index) => `bulk_${String(index).padStart(2, "0")}`);
        for (const id of many) product({ id, categoryId: "cat_shirts" });

        const result = await recommend(many, 12);

        // Only the first 20 ids are sources; the rest stay recommendable.
        expect(result.products).toHaveLength(12);
        expect(ids(result).every((id) => many.indexOf(id) >= MAX_RECOMMENDATION_SOURCE_IDS)).toBe(true);
        expect(statements).toHaveLength(2);
        expect(maxBoundParameters).toBeLessThanOrEqual(90);
    });

    it("expands only the source's collections and orders, never the whole store", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "peer", categoryId: "cat_trousers" });
        collection("col_menswear", { source: "dynamic", categoryIds: ["cat_shirts", "cat_trousers"] });
        collection("col_pick", { source: "manual", productIds: ["source", "peer"] });

        expect(ids(await recommend(["source"]))).toEqual(["peer"]);

        // Without statistics SQLite used to start the dynamic-collection
        // expansion from every published category and every product in the
        // store (1.3 s per product page at 30k products).
        const index = statements.findIndex((query) => query.includes("rec_collection_peer"));
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${statements[index]}`)
            .all(...statementParams[index]!)
            .map((step) => String(step.detail));
        expect(plan.join("\n")).not.toMatch(/SEARCH rec_(peer|source)_category USING INDEX categories_public_idx/);
        expect(plan.join("\n")).not.toMatch(/SCAN rec_(peer|source)_product/);
        // Also-bought starts from the source products' order lines, not from
        // every order of the last year.
        expect(plan.join("\n")).toMatch(/SEARCH rec_source_line USING INDEX order_items_product_id_idx/);
    });

    it("ships ranked recommendations on the product page payload", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "neighbour", categoryId: "cat_shirts", photos: 2 });

        const detail = await getStorefrontProductBySlug(db, "source");

        expect(detail?.recommendations.reason).toBe("similar");
        expect(detail?.recommendations.products.map((item) => item.id)).toEqual(["neighbour"]);
        expect(detail?.recommendations.products[0]?.secondaryImageUrl).toContain("media_neighbour_1");
    });
});
