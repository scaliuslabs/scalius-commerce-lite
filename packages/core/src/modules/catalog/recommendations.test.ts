import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    getStorefrontProductRecommendations,
    MAX_RECOMMENDATION_SOURCE_IDS,
    rankProductRecommendations,
    rankRecommendationRows,
} from "./recommendations";
import { getStorefrontProductBySlug } from "./product-page";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { refreshProductRecommendations, refreshProductSalesStats } from "./recommendation-refresh";

import { withDependencyScope } from "../../cache-deps";

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
    // Seeded with raw SQL: fill the stored buyer state as a release does.
    await rebuildCatalogProjections(db);
    statements = [];
    statementParams = [];
    return getStorefrontProductRecommendations(db, { productIds, limit });
}

const scoreRows = (rows: Array<Record<string, unknown>>) => rows.filter((row) => row.id !== null).map((row) => ({
    id: row.id, alsoBoughtBuyers: row.alsoBoughtBuyers, relatedScore: row.relatedScore,
    popularBuyers: row.popularBuyers, popularOrdering: row.popularOrdering,
}));

function originalOrderPopularity(query: string): string {
    // Independent source oracle: duplicate lines remain here, and neither
    // eligibility, parent time nor normalized buyer comes from the projection.
    // This also restores the popularity deadline's real-order/has-line set.
    const source = query.replaceAll(/\brecommendation_order_products\b/g, `(
        SELECT original_order.id AS order_id, original_line.product_id, original_order.created_at,
            COALESCE(NULLIF(original_order.customer_phone, ''), lower(trim(original_order.customer_email))) AS buyer
        FROM orders AS original_order
        INNER JOIN order_items AS original_line ON original_line.order_id = original_order.id
        WHERE original_order.deleted_at IS NULL
          AND original_order.status IN ('pending', 'processing', 'confirmed', 'shipped', 'delivered', 'completed')
    )`);
    expect(source).not.toBe(query);
    expect(source).not.toContain("recommendation_order_products");
    return source;
}

function fullUniverseRanking(query: string, limit: number): string {
    // Check optimization equivalence with shared scoring formulas: disable
    // cutoffs and restore full affinity and full-population popularity reads.
    const noCoBuyCutoff = query.replace("SELECT CASE WHEN COUNT(*) >=", "SELECT CASE WHEN 0 AND COUNT(*) >=");
    expect(noCoBuyCutoff).not.toBe(query);
    const noRelatedCutoff = noCoBuyCutoff.replace(
        "SELECT CASE WHEN also_bought_tier > 0 OR affinity > 15 THEN", "SELECT CASE WHEN 0 THEN",
    );
    expect(noRelatedCutoff).not.toBe(noCoBuyCutoff);
    const noRelatedReuse = noRelatedCutoff.replace(
        /SELECT \* FROM rec_related_affinity(\s+UNION ALL)/, "SELECT * FROM rec_related_affinity WHERE 0 = 1$1",
    );
    expect(noRelatedReuse).not.toBe(noRelatedCutoff);
    const fullAffinity = noRelatedReuse.replace(
        '"product_buyer_state"."product_id" NOT IN (SELECT product_id FROM rec_related_affinity)', "1 = 1",
    );
    expect(fullAffinity).not.toBe(noRelatedReuse);
    const noAffinityCutoff = fullAffinity.replace(
        /AND \(rec_affinity_cutoff\.also_bought_tier IS NULL[\s\S]*?product_buyer_state\.affinity >= rec_affinity_cutoff\.affinity\)\)/,
        "",
    );
    expect(noAffinityCutoff).not.toBe(fullAffinity);
    const allPopularity = noAffinityCutoff.replace(
        "AND rec_popular_projection.product_id IN (SELECT product_id FROM rec_candidates)", "",
    );
    expect(allPopularity).not.toBe(noAffinityCutoff);
    const originalPopularity = `SUM(CASE WHEN COALESCE(rec_popular.buyers, 0) >= 2 THEN 1 ELSE 0 END) OVER () * 2 >= MIN(COUNT(*) OVER (), ${limit})`;
    const canonical = allPopularity.replaceAll("(SELECT qualifies FROM rec_popularity_guard) = 1", originalPopularity);
    expect(canonical).not.toBe(allPopularity);
    return originalOrderPopularity(canonical);
}

function affinityVisits(query: string, params: readonly SQLInputValue[]) {
    const seen = { guard: [] as number[], scored: [[], []] as [string[], string[]] };
    sqlite.function("observe_related_guard", value => { seen.guard.push(Number(value)); return value; });
    for (const branch of [0, 1]) {
        sqlite.function(`observe_affinity_${branch}`, value => { seen.scored[branch]!.push(String(value)); return value; });
    }
    let branch = 0;
    const observed = query
        .replace(/(rec_related_guard AS MATERIALIZED\s*\(\s*SELECT )COALESCE/, "$1observe_related_guard(COALESCE")
        .replace(/\), 0\) AS qualifies(\s*\),\s*rec_fallback_affinity)/, "), 0)) AS qualifies$1")
        .replace(/(select )("product_buyer_state"\."product_id")( as "product_id")/gi,
            (_match, select, id, alias) => `${select}observe_affinity_${branch++}(${id})${alias}`);
    expect(branch).toBe(2);
    expect(sqlite.prepare(observed).all(...params)).toEqual(sqlite.prepare(query).all(...params));
    return seen;
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

afterEach(() => sqlite.close());

const recordedRecommendations = (productIds: string[]) => withDependencyScope(
    () => getStorefrontProductRecommendations(db, { productIds, limit: 12 }),
    { log: () => {} },
);
const sequence = (key: string) => Number((sqlite.prepare("SELECT seq FROM cache_dep WHERE dep = ?").get(key) as { seq: number } | undefined)?.seq ?? 0);

describe("product recommendations", () => {
    it("caches quiet empty fallback without an age limit or private dependency values", async () => {
        const { value, dependencies } = await recordedRecommendations([]);
        expect(value.products).toEqual([]);
        expect(dependencies.keys).toContain("recommendation-signals");
        expect(dependencies.validUntil).toBeNull();
        expect(dependencies.softMaxAgeSeconds).toBeNull();
        expect(dependencies.uncacheable).toEqual([]);
    });

    it.each([30, 365])("expires live ranking exactly when an included %i-day order ages out", async (days) => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "peer", categoryId: "cat_shirts" });
        const createdAt = NOW - days * 86400 + 100;
        order("01711000001", ["source", "peer"], "completed", createdAt);
        await rebuildCatalogProjections(db);
        const { dependencies } = await recordedRecommendations(["source"]);
        expect(dependencies.validUntil).toBe((createdAt + days * 86400 + 1) * 1000);
        expect(dependencies.keys).toContain("rec:source"); // missing stored rows must invalidate when filled
        expect(dependencies.keys).toContain("recommendation-signals");
        expect(dependencies.keys).toContain("lo:price:all");
        expect(dependencies.keys).toContain("lo:band:all");
        expect(dependencies.keys.join(" ")).not.toMatch(/01711000001|ord_1/);
        expect(dependencies.softMaxAgeSeconds).toBeNull();
    });

    it.each([30, 365])("keeps the %i-day deadline when the ranking has no rows", async (days) => {
        product({ id: "source", stock: 0 });
        const createdAt = NOW - days * 86400 + 100;
        order("buyer", ["source"], "completed", createdAt);
        await rebuildCatalogProjections(db);
        statements = [];
        const { value, dependencies } = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source"] }), { strict: true, log: () => {} },
        );
        expect(value.rows).toEqual([]);
        expect(dependencies.validUntil).toBe((createdAt + days * 86400 + 1) * 1000);
        expect(statements).toHaveLength(1);
        if (days === 30) {
            statements = [];
            const emptySource = await withDependencyScope(
                () => rankProductRecommendations(db, { productIds: [] }), { strict: true, log: () => {} },
            );
            expect(emptySource.value.rows).toEqual([]);
            expect(emptySource.dependencies.validUntil).toBe(dependencies.validUntil);
            expect(statements).toHaveLength(1);
        }
    });

    it("preserves price-band, timestamp and id ties through the recorded ranking wrapper", async () => {
        product({ id: "source" });
        product({ id: "far_new", priceMinor: 900000, createdAt: NOW - 10 });
        product({ id: "near_old", createdAt: NOW - 100 });
        product({ id: "near_b", createdAt: NOW - 50 });
        product({ id: "near_a", createdAt: NOW - 50 });
        await rebuildCatalogProjections(db);
        const direct = await rankProductRecommendations(db, { productIds: ["source"], limit: 4 });
        expect(direct.rows.map((row) => row.id)).toEqual(["near_a", "near_b", "near_old", "far_new"]);
        statements = [];
        const recorded = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source"], limit: 4 }), { strict: true, log: () => {} },
        );
        expect(recorded.value).toEqual(direct);
        expect(recorded.dependencies.validUntil).toBeNull();
        expect(statements).toHaveLength(1);
    });

    it("reads the live ranking deadline from bounded index reads, never every order of the year", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "peer", categoryId: "cat_shirts" });
        order("01711000001", ["source", "peer"], "completed", NOW - 40 * 86400);
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const { dependencies } = await recordedRecommendations(["source"]);
        expect(dependencies.validUntil).not.toBeNull();
        const index = statements.findIndex((query) => query.includes("rec_popular_first"));
        expect(index).toBeGreaterThanOrEqual(0);
        const steps = sqlite.prepare(`EXPLAIN QUERY PLAN ${statements[index]}`).all(...statementParams[index]!);
        const plan = steps.map((step) => String(step.detail));
        // It scanned every live order, probing each for a source line: minutes on a million orders.
        expect(plan.filter((detail) => /^SCAN rec_(popular_first|source_order)|USING (COVERING )?INDEX orders_\w+ \(deleted_at=\?\)$/.test(detail))).toEqual([]);
        expect(plan.filter((detail) => detail.startsWith("SEARCH rec_source_line_sample "))).toHaveLength(1);
        expect(plan.filter((detail) => detail === "MATERIALIZE rec_source_orders")).toHaveLength(1);
        expect(plan.join("\n")).toMatch(/SEARCH rec_source_line_sample USING COVERING INDEX order_items_product_recent_idx/);
        expect(plan.join("\n")).toContain("SEARCH rec_popular_first USING COVERING INDEX recommendation_order_products_created_idx (created_at>?)");
        expect(sqlite.prepare(statements[index]!).all(...statementParams[index]!))
            .toEqual(sqlite.prepare(originalOrderPopularity(statements[index]!)).all(...statementParams[index]!));
        const sample = steps.find((step) => String(step.detail).startsWith("SEARCH rec_source_line_sample "))!;
        expect(steps.filter((step) => step.parent === sample.parent).map((step) => String(step.detail)).join("\n"))
            .not.toMatch(/USE TEMP B-TREE FOR .*ORDER BY/);
    });

    it("ignores old and cancelled orders when selecting a live ranking deadline", async () => {
        product({ id: "source" });
        product({ id: "peer" });
        order("01711000001", ["source", "peer"], "completed", NOW - 366 * 86400);
        order("01711000002", ["source", "peer"], "cancelled", NOW - 29 * 86400);
        await rebuildCatalogProjections(db);
        const { dependencies } = await recordedRecommendations(["source"]);
        expect(dependencies.validUntil).toBeNull();
        expect(dependencies.softMaxAgeSeconds).toBeNull();
    });

    it("keeps unchanged stored projections stable and invalidates changed ranking positions", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "older", categoryId: "cat_shirts", createdAt: NOW - 100 });
        product({ id: "newer", categoryId: "cat_shirts", createdAt: NOW - 50 });
        await rebuildCatalogProjections(db);
        await refreshProductRecommendations(db, ["source"]);
        const before = sequence("rec:source");
        expect(before).toBeGreaterThan(0);
        await refreshProductRecommendations(db, ["source"]);
        expect(sequence("rec:source")).toBe(before);
        const stored = await recordedRecommendations(["source"]);
        expect(stored.dependencies.keys).toContain("rec:source");
        expect(stored.dependencies.keys).not.toContain("recommendation-signals");
        expect(stored.dependencies.validUntil).toBeNull();
        expect(stored.dependencies.softMaxAgeSeconds).toBeNull();
        order("01711000001", ["source", "older"]);
        order("01711000002", ["source", "older"]);
        expect(sequence("rec:source")).toBe(before);
        await refreshProductRecommendations(db, ["source"]);
        expect(sequence("rec:source")).toBeGreaterThan(before);
        expect(ids((await recordedRecommendations(["source"])).value)).toEqual(["older", "newer"]);
    });

    it("refreshes sales projections without invalidating unchanged visible counts", async () => {
        product({ id: "source" });
        order("01711000001", ["source"]);
        sqlite.exec("UPDATE order_items SET quantity = 12");
        expect(await refreshProductSalesStats(db)).toEqual({ products: 1 });
        const sold = sequence("sold:source");
        const popular = sequence("popular");
        expect(sold).toBeGreaterThan(0);
        await refreshProductSalesStats(db);
        expect(sequence("sold:source")).toBe(sold);
        expect(sequence("popular")).toBe(popular);
        sqlite.exec("UPDATE orders SET status = 'cancelled'");
        expect(await refreshProductSalesStats(db)).toEqual({ products: 0 });
        expect(sequence("sold:source")).toBeGreaterThan(sold);
        expect(sequence("popular")).toBeGreaterThan(popular);
    });

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
        // Never computed: the stored-list read, the live ranking, then the
        // kept rows' cards and media.
        expect(statements).toHaveLength(4);
        // The ranking scores every public product, so it reads the buyer
        // state alone; card columns are read for the kept rows only.
        const ranking = statements.find((query) => query.includes("rec_co_purchase"))!;
        expect(ranking).not.toContain('"products"."name"');
        expect(ranking).not.toContain("buyer_state_card_sku");
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

    it("covers recent buyer and order-line reads without changing live scores or the strict deadline", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "peer", categoryId: "cat_trousers", priceMinor: 900_000 });
        product({ id: "similar", categoryId: "cat_shirts" });
        product({ id: "sold_out", stock: 0 });
        product({ id: "hidden", isActive: false });
        const basket = ["source", "source", "peer", "sold_out", "hidden"];
        order("01711111111", basket, "pending");
        order("01711111111", basket, "delivered");
        order("", basket, "processing");
        sqlite.prepare("UPDATE orders SET customer_email = ? WHERE id = ?").run("buyer@example.com", `ord_${orderSequence}`);
        order("", basket, "confirmed");
        sqlite.prepare("UPDATE orders SET customer_email = ? WHERE id = ?").run(" BUYER@EXAMPLE.COM ", `ord_${orderSequence}`);
        order("01722222222", basket, "completed", NOW - 40 * 86_400);
        for (const status of ["cancelled", "incomplete", "refunded", "returned"]) {
            order(`excluded_${status}`, basket, status);
        }
        order("01733333333", basket);
        sqlite.prepare("UPDATE orders SET deleted_at = ? WHERE id = ?").run(NOW, `ord_${orderSequence}`);
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];

        const { value, dependencies } = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source"], limit: 8 }),
            { strict: true, log: () => {} },
        );
        expect(value).toEqual({
            reason: "also_bought",
            rows: [
                { id: "peer", alsoBoughtBuyers: 3, relatedScore: 0, popularBuyers: 2, popularOrdering: 2 },
                { id: "similar", alsoBoughtBuyers: 0, relatedScore: 40, popularBuyers: 0, popularOrdering: 0 },
            ],
        });
        expect(dependencies.validUntil).toBe((NOW - 3_600 + 30 * 86_400 + 1) * 1_000);
        expect(dependencies.keys).toContain("recommendation-signals");
        expect(dependencies.uncacheable).toEqual([]);
        expect(dependencies.coarseTables).toEqual([]);
        expect(statements).toHaveLength(1);
        const plan = statements.flatMap((query, index) => sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`)
            .all(...statementParams[index]!).map((step) => String(step.detail))).join("\n");
        expect(plan).toContain("SEARCH product_buyer_state USING COVERING INDEX product_buyer_state_price_idx (is_public=?)");
        // A non-covering lookup per order/line took 18 seconds at one million orders.
        expect(plan).toContain("SEARCH rec_popular_first USING COVERING INDEX recommendation_order_products_created_idx (created_at>?)");
        for (const alias of ["rec_peer_line"]) {
            expect(plan).toMatch(new RegExp(`SEARCH ${alias} USING COVERING INDEX order_items_order_product_idx`));
        }
        expect(plan).toContain("SEARCH rec_popular_projection USING COVERING INDEX recommendation_order_products_product_idx (product_id=? AND created_at>?)");
        expect(plan).toMatch(/SEARCH rec_source_pair USING (?:COVERING )?INDEX \S+ \(order_id=\? AND product_id=\?\)/);
        expect(plan).not.toMatch(/(?:SEARCH|SCAN) rec_source_order(?: |$)/m);
        // Compare both exact score rows and the strict boundary with the old
        // orders and lines, including duplicate source lines and buyers.
        for (const [index, query] of statements.entries()) {
            expect(sqlite.prepare(query).all(...statementParams[index]!))
                .toEqual(sqlite.prepare(originalOrderPopularity(query)).all(...statementParams[index]!));
        }
    });

    it("matches original orders for parent-time popularity across source counts and duplicate SKU lines", async () => {
        for (const id of ["source", "source_b", "peer", "rival"]) product({ id });
        for (const status of ["pending", "processing", "confirmed", "shipped", "delivered", "completed"]) {
            order(`buyer_${status}`, ["peer", "peer"], status);
        }
        for (const email of [" Buyer@Example.com ", "buyer@example.com"]) {
            order("", ["peer", "peer"]);
            sqlite.prepare("UPDATE orders SET customer_email = ? WHERE id = ?").run(email, `ord_${orderSequence}`);
        }
        order("", ["peer"]); // NULL buyer is not a distinct buyer.
        sqlite.prepare("UPDATE orders SET customer_email = NULL WHERE id = ?").run(`ord_${orderSequence}`);
        const boundary = NOW - 30 * 86400 + 100;
        order("boundary", ["peer", "peer"], "completed", boundary);
        // These old SKU-line times must not remove recent parent orders.
        sqlite.prepare("UPDATE order_items SET created_at = ?, variant_id = 'var_peer'").run(NOW - 400 * 86400);
        order("old_parent", ["peer", "peer"], "completed", NOW - 31 * 86400);
        // Conversely, a fresh line cannot restore an expired parent order.
        sqlite.prepare("UPDATE order_items SET created_at = ? WHERE order_id = ?").run(NOW, `ord_${orderSequence}`);
        for (const status of ["cancelled", "incomplete", "refunded", "returned"]) order(`excluded_${status}`, ["peer"], status);
        order("deleted", ["peer"]);
        sqlite.prepare("UPDATE orders SET deleted_at = ? WHERE id = ?").run(NOW, `ord_${orderSequence}`);
        await rebuildCatalogProjections(db);

        let lastQuery = "";
        let lastParams: readonly SQLInputValue[] = [];
        for (const productIds of [[], ["source"], ["source", "source_b"]]) {
            statements = [];
            statementParams = [];
            const { value, dependencies } = await withDependencyScope(
                () => rankProductRecommendations(db, { productIds, limit: 3 }), { strict: true, log: () => {} },
            );
            expect(value.rows.find(row => row.id === "peer")?.popularBuyers).toBe(8);
            expect(dependencies.validUntil).toBe((boundary + 30 * 86400 + 1) * 1000);
            expect(dependencies.uncacheable).toEqual([]);
            expect(statements).toHaveLength(1);
            lastQuery = statements[0]!;
            lastParams = statementParams[0]!;
            expect(sqlite.prepare(lastQuery).all(...lastParams))
                .toEqual(sqlite.prepare(originalOrderPopularity(lastQuery)).all(...lastParams));
            if (productIds.length > 0) {
                expect(scoreRows(sqlite.prepare(fullUniverseRanking(lastQuery, 3)).all(...lastParams))).toEqual(value.rows);
            }
        }
        // Prove the oracle cannot silently inherit a corrupt projection.
        const sourceQuery = originalOrderPopularity(lastQuery);
        const sourceRows = sqlite.prepare(sourceQuery).all(...lastParams);
        sqlite.exec("DELETE FROM recommendation_order_products");
        expect(sqlite.prepare(sourceQuery).all(...lastParams)).toEqual(sourceRows);
        expect(sqlite.prepare(lastQuery).all(...lastParams)).not.toEqual(sourceRows);
    });

    it("uses the complete co-buy tier only when its eligible recent witnesses prove the popularity quorum", async () => {
        for (const [index, id] of ["source", "peer_a", "peer_b", "peer_c", "peer_d", "outsider"].entries()) {
            product({ id, createdAt: NOW - 100 + index });
        }
        product({ id: "hidden", isActive: false });
        product({ id: "sold_out", stock: 0 });
        const recentBasket = ["source", "source", "peer_a", "peer_a", "peer_b", "hidden", "sold_out"];
        order("phone_a", recentBasket);
        order("phone_a", recentBasket, "delivered");
        order("", recentBasket);
        sqlite.prepare("UPDATE orders SET customer_email = ? WHERE id = ?").run("buyer@example.com", `ord_${orderSequence}`);
        order("", recentBasket);
        sqlite.prepare("UPDATE orders SET customer_email = ? WHERE id = ?").run(" BUYER@EXAMPLE.COM ", `ord_${orderSequence}`);
        for (const buyer of ["old_a", "old_b"]) order(buyer, ["source", "peer_c", "peer_d"], "completed", NOW - 40 * 86400);
        for (let buyer = 0; buyer < 4; buyer += 1) {
            order(`global_${buyer}`, buyer < 3 ? ["peer_c", "peer_d", "outsider"] : ["peer_d", "outsider"]);
        }
        for (const status of ["cancelled", "incomplete", "refunded", "returned"]) {
            order(`excluded_${status}`, ["source", "peer_d"], status);
        }
        order("deleted", ["source", "peer_d"]);
        sqlite.prepare("UPDATE orders SET deleted_at = ? WHERE id = ?").run(NOW, `ord_${orderSequence}`);
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const { value, dependencies } = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source"], limit: 3 }),
            { strict: true, log: () => {} },
        );
        expect(value).toEqual({ reason: "also_bought", rows: [
            { id: "peer_d", alsoBoughtBuyers: 2, relatedScore: 0, popularBuyers: 4, popularOrdering: 4 },
            { id: "peer_c", alsoBoughtBuyers: 2, relatedScore: 0, popularBuyers: 3, popularOrdering: 3 },
            { id: "peer_b", alsoBoughtBuyers: 2, relatedScore: 0, popularBuyers: 2, popularOrdering: 2 },
        ] });
        expect(statements).toHaveLength(1);
        expect(dependencies.validUntil).toBe((NOW - 3600 + 30 * 86400 + 1) * 1000);
        expect(dependencies.uncacheable).toEqual([]);
        expect(dependencies.coarseTables).toEqual([]);
        const index = statements.findIndex((query) => query.includes("rec_guard AS MATERIALIZED"));
        const query = statements[index]!;
        const params = statementParams[index]!;
        const canonical = fullUniverseRanking(query, 3);
        expect(canonical).not.toBe(query);
        expect(scoreRows(sqlite.prepare(canonical).all(...params))).toEqual(value.rows);
        expect(sqlite.prepare(query).all(...params)).toEqual(sqlite.prepare(canonical).all(...params));

        const guardValues: number[] = [];
        let quorumVisits = 0;
        sqlite.function("observe_guard", (value) => { guardValues.push(Number(value)); return value; });
        sqlite.function("observe_global_quorum", (value) => { quorumVisits += 1; return value; });
        const observed = query
            .replace("THEN 1 ELSE 0 END AS qualifies", "THEN observe_guard(1) ELSE observe_guard(0) END AS qualifies")
            .replace("AND rec_quorum_projection.created_at >= unixepoch()", "AND observe_global_quorum(rec_quorum_projection.created_at) >= unixepoch()");
        expect(observed).toContain("observe_global_quorum(rec_quorum_projection.created_at)");
        expect(scoreRows(sqlite.prepare(observed).all(...params))).toEqual(value.rows);
        expect(guardValues).toEqual([1]);
        expect(quorumVisits).toBe(0);
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params).map((row) => String(row.detail));
        expect(plan.filter((line) => line.startsWith("SEARCH rec_source_line_sample "))).toHaveLength(1);
        expect(plan.filter((line) => line.startsWith("SEARCH rec_popular_projection "))).toEqual([
            "SEARCH rec_popular_projection USING COVERING INDEX recommendation_order_products_product_idx (product_id=? AND created_at>?)",
        ]);
    });

    it("keeps global popularity enabled when its recent witnesses are below the winning cutoff", async () => {
        product({ id: "source" });
        const winners = ["high_a", "high_b", "high_c", "high_d"];
        for (const [index, id] of winners.entries()) product({ id, createdAt: NOW - 100 + index });
        for (const id of ["witness_a", "witness_b"]) product({ id });
        for (let buyer = 0; buyer < 4; buyer += 1) {
            order(`annual_${buyer}`, ["source", ...winners], "completed", NOW - 40 * 86400);
        }
        for (const buyer of ["recent_a", "recent_b"]) {
            order(buyer, ["source", "witness_a", "witness_b"]);
            order(buyer, ["high_a"]);
        }
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const result = await rankProductRecommendations(db, { productIds: ["source"], limit: 3 });
        // Only one of four tied winners is popular. The discarded witnesses
        // still enable the global switch, placing that older winner first.
        expect(result.rows).toEqual([
            { id: "high_a", alsoBoughtBuyers: 4, relatedScore: 0, popularBuyers: 2, popularOrdering: 2 },
            { id: "high_d", alsoBoughtBuyers: 4, relatedScore: 0, popularBuyers: 0, popularOrdering: 0 },
            { id: "high_c", alsoBoughtBuyers: 4, relatedScore: 0, popularBuyers: 0, popularOrdering: 0 },
        ]);
        const query = statements[0]!;
        const canonical = fullUniverseRanking(query, 3);
        expect(canonical).not.toBe(query);
        expect(scoreRows(sqlite.prepare(canonical).all(...statementParams[0]!))).toEqual(result.rows);
    });

    it("keeps every cutoff tie and exact scores for the 24-row stored refresh", async () => {
        product({ id: "source" });
        const peers = Array.from({ length: 25 }, (_, index) => `peer_${String(index).padStart(2, "0")}`);
        for (const [index, id] of peers.entries()) product({ id, createdAt: NOW - 100 + index });
        order("buyer_a", ["source", "source", ...peers]);
        order("buyer_b", ["source", ...peers]);
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const { value: rows, dependencies } = await withDependencyScope(
            () => rankRecommendationRows(db, ["source"], 24), { strict: true, log: () => {} },
        );
        expect(dependencies.validUntil).toBe((NOW - 3600 + 30 * 86400 + 1) * 1000);
        expect(rows).toEqual([...peers].reverse().slice(0, 24).map((id) => ({
            id, alsoBoughtBuyers: 2, relatedScore: 0, popularBuyers: 2, popularOrdering: 2,
        })));
        expect(statements).toHaveLength(1);
        const canonical = fullUniverseRanking(statements[0]!, 24);
        expect(canonical).not.toBe(statements[0]);
        expect(scoreRows(sqlite.prepare(canonical).all(...statementParams[0]!))).toEqual(rows);
        await expect(refreshProductRecommendations(db, ["source"])).resolves.toEqual({ refreshed: 1, cleared: 0 });
        const stored = sqlite.prepare("SELECT recommended_product_id AS id FROM product_recommendations WHERE product_id = 'source' ORDER BY position").all();
        expect(stored.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    });

    it.each(["no_source", "no_history", "underfilled", "insufficient_recent"] as const)(
        "keeps canonical ranking through the fallback for %s",
        async (scenario) => {
            for (const id of ["source", "peer_a", "peer_b", "peer_c", "peer_d"]) product({ id });
            product({ id: "hidden", isActive: false });
            product({ id: "sold_out", stock: 0 });
            for (const buyer of ["global_a", "global_b"]) order(buyer, ["peer_a", "peer_b", "peer_c", "peer_d"]);
            if (scenario === "underfilled") {
                for (const buyer of ["co_a", "co_b"]) order(buyer, ["source", "peer_a", "hidden", "sold_out"]);
            } else if (scenario === "insufficient_recent") {
                for (const buyer of ["old_a", "old_b"]) order(buyer, ["source", "peer_a", "peer_b", "peer_c", "peer_d"], "completed", NOW - 40 * 86400);
                for (const buyer of ["co_a", "co_b"]) order(buyer, ["source", "peer_a"]);
            }
            await rebuildCatalogProjections(db);
            statements = [];
            statementParams = [];
            const result = await rankProductRecommendations(db, {
                productIds: scenario === "no_source" ? [] : ["source"], limit: 3,
            });
            expect(statements).toHaveLength(1);
            expect(result.rows).toHaveLength(3);
            const query = statements[0]!;
            const params = statementParams[0]!;
            expect(sqlite.prepare(query).all(...params)).toEqual(sqlite.prepare(originalOrderPopularity(query)).all(...params));
            if (scenario === "no_source") {
                expect(query).not.toContain("rec_guard");
                expect(query).not.toContain("rec_candidates");
                return;
            }
            const canonical = fullUniverseRanking(query, 3);
            expect(canonical).not.toBe(query);
            expect(scoreRows(sqlite.prepare(canonical).all(...params))).toEqual(result.rows);
            const guardValues: number[] = [];
            sqlite.function("observe_guard", (value) => { guardValues.push(Number(value)); return value; });
            const observed = query.replace("THEN 1 ELSE 0 END AS qualifies", "THEN observe_guard(1) ELSE observe_guard(0) END AS qualifies");
            expect(scoreRows(sqlite.prepare(observed).all(...params))).toEqual(result.rows);
            expect(guardValues).toEqual([0]);
        },
    );

    it("keeps fallback affinity ties and counts popularity witnesses outside the cutoff only while eligible", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        const peers = ["peer_a", "peer_b", "peer_c", "peer_d", "peer_e"];
        for (const id of peers) product({ id, categoryId: "cat_shirts", createdAt: NOW - 100 });
        product({ id: "outside", categoryId: "cat_trousers" });
        product({ id: "hidden", categoryId: "cat_trousers", isActive: false });
        product({ id: "sold_out", categoryId: "cat_trousers", stock: 0 });
        for (const buyer of ["buyer_a", "buyer_b"]) {
            order(buyer, ["peer_b", "outside", "hidden", "sold_out"]);
            order(buyer, ["source"]);
        }

        const read = async () => {
            await rebuildCatalogProjections(db);
            statements = [];
            statementParams = [];
            const result = await withDependencyScope(
                () => rankProductRecommendations(db, { productIds: ["source"], limit: 3 }),
                { strict: true, log: () => {} },
            );
            expect(statements).toHaveLength(1);
            const query = statements[0]!;
            const params = statementParams[0]!;
            expect(sqlite.prepare(query).all(...params))
                .toEqual(sqlite.prepare(fullUniverseRanking(query, 3)).all(...params));
            const visits = affinityVisits(query, params);
            expect(visits.guard).toEqual([1]);
            expect(visits.scored[1]).toEqual([]);
            expect(result.dependencies.validUntil).toBe((NOW - 3600 + 30 * 86400 + 1) * 1000);
            expect(result.dependencies.uncacheable).toEqual([]);
            expect(result.dependencies.coarseTables).toEqual([]);
            return result.value;
        };
        const enabled = await read();
        expect(enabled.reason).toBe("similar");
        expect(enabled.rows.map((row) => row.id)).toEqual(["peer_b", "peer_a", "peer_c"]);
        expect(enabled.rows[0]).toMatchObject({ alsoBoughtBuyers: 0, relatedScore: 40, popularBuyers: 2, popularOrdering: 2 });

        sqlite.prepare("UPDATE product_variants SET stock = 0 WHERE id = 'var_outside'").run();
        const disabled = await read();
        expect(disabled.rows.map((row) => row.id)).toEqual(["peer_a", "peer_b", "peer_c"]);
        // Hidden/sold-out/source products cannot keep the global switch on.
        // Exact buyer counts survive even when they no longer order the rows.
        expect(disabled.rows[1]).toMatchObject({ popularBuyers: 2, popularOrdering: 0 });
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("counts only finalists while proving the global quorum from distinct eligible buyers", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        for (const id of ["peer_a", "peer_b", "peer_c"]) product({ id, categoryId: "cat_shirts" });
        product({ id: "outside", categoryId: "cat_trousers" });
        product({ id: "hidden", isActive: false });
        product({ id: "sold_out", stock: 0 });
        order("buyer_a", ["peer_b", "peer_b"]);
        for (let repeat = 0; repeat < 3; repeat += 1) order("buyer_b", ["peer_b", "peer_b"]);
        for (let repeat = 0; repeat < 4; repeat += 1) order("buyer_a", ["outside", "outside"]);
        const outsideOrder = `ord_${orderSequence}`;
        order("", ["outside"]);
        sqlite.prepare("UPDATE orders SET customer_email = NULL WHERE id = ?").run(`ord_${orderSequence}`);
        for (const buyer of ["buyer_a", "buyer_b"]) {
            order(buyer, ["hidden", "sold_out"]);
            order(buyer, ["source"]);
        }
        await rebuildCatalogProjections(db);

        const read = async (enabled: boolean) => {
            statements = [];
            statementParams = [];
            const { value, dependencies } = await withDependencyScope(
                () => rankProductRecommendations(db, { productIds: ["source"], limit: 3 }),
                { strict: true, log: () => {} },
            );
            expect(value.rows.map(row => row.id)).toEqual(enabled
                ? ["peer_b", "peer_a", "peer_c"] : ["peer_a", "peer_b", "peer_c"]);
            expect(value.rows.find(row => row.id === "peer_b"))
                .toMatchObject({ popularBuyers: 2, popularOrdering: enabled ? 2 : 0 });
            const query = statements[0]!;
            const params = statementParams[0]!;
            expect(statements).toHaveLength(1);
            expect(sqlite.prepare(query).all(...params))
                .toEqual(sqlite.prepare(fullUniverseRanking(query, 3)).all(...params));
            expect(dependencies.validUntil).toBe((NOW - 3600 + 30 * 86400 + 1) * 1000);
            expect(dependencies.uncacheable).toEqual([]);

            const counted = new Set<string>();
            const quorum = new Map<string, number>();
            sqlite.function("observe_finalist_buyer", (id, buyer) => { counted.add(String(id)); return buyer; });
            sqlite.function("observe_quorum_buyer", (id, buyer) => {
                quorum.set(String(id), (quorum.get(String(id)) ?? 0) + 1);
                return buyer;
            });
            const observed = query
                .replace("COUNT(DISTINCT rec_popular_projection.buyer)", "COUNT(DISTINCT observe_finalist_buyer(rec_popular_projection.product_id, rec_popular_projection.buyer))")
                .replace("SELECT DISTINCT rec_quorum_projection.buyer", "SELECT DISTINCT observe_quorum_buyer(rec_quorum_projection.product_id, rec_quorum_projection.buyer)");
            expect(observed).toContain("SELECT DISTINCT observe_quorum_buyer");
            expect(scoreRows(sqlite.prepare(observed).all(...params))).toEqual(value.rows);
            expect([...counted]).toEqual(["peer_b"]);
            expect([...quorum.keys()].sort()).toEqual(["outside", "peer_b"]);
            // The finalist has four orders from two buyers; the second
            // distinct buyer stops the witness probe before its repeats.
            expect(quorum.get("peer_b")).toBe(2);
            const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params)
                .map(row => String(row.detail)).join("\n");
            expect(plan).toContain("SEARCH rec_quorum_projection USING COVERING INDEX recommendation_order_products_product_idx (product_id=? AND created_at>?)");
        };
        await read(false);
        sqlite.prepare("UPDATE orders SET customer_phone = 'buyer_b' WHERE id = ?").run(outsideOrder);
        await read(true);
    });

    it("covers every related signal once while keeping popularity witnesses outside the sparse set", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        for (const id of ["overlap", "category_peer"]) product({ id, categoryId: "cat_shirts" });
        for (const id of ["collection_peer", "attribute_peer", "single_peer", "outside_a", "outside_b"]) {
            product({ id, categoryId: "cat_trousers" });
        }
        product({ id: "hidden", categoryId: "cat_shirts", isActive: false });
        product({ id: "sold_out", categoryId: "cat_shirts", stock: 0 });
        collection("col_sparse", { source: "manual", productIds: ["source", "overlap", "collection_peer", null] });
        for (const id of ["source", "overlap", "attribute_peer"]) attribute(id, "attr_sparse", "same");
        order("single_buyer", ["source", "single_peer"]);
        for (const buyer of ["global_a", "global_b"]) order(buyer, ["attribute_peer", "outside_a", "outside_b"]);
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const result = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source", "source"], limit: 5 }),
            { strict: true, log: () => {} },
        );
        expect(result.value.rows.map(row => row.id))
            .toEqual(["overlap", "category_peer", "collection_peer", "single_peer", "attribute_peer"]);
        expect(result.value.rows.at(-1)).toMatchObject({ popularBuyers: 2, popularOrdering: 2 });
        const query = statements[0]!;
        const params = statementParams[0]!;
        expect(sqlite.prepare(query).all(...params)).toEqual(sqlite.prepare(fullUniverseRanking(query, 5)).all(...params));
        const visits = affinityVisits(query, params);
        expect(visits.guard).toEqual([1]);
        expect(visits.scored[0].sort()).toEqual(["attribute_peer", "category_peer", "collection_peer", "overlap", "single_peer"]);
        expect(visits.scored[1]).toEqual([]);
        expect(result.dependencies.uncacheable).toEqual([]);
        expect(result.dependencies.coarseTables).toEqual([]);
        expect(maxBoundParameters).toBeLessThanOrEqual(100);
    });

    it("reuses dense weak relations and scores only unrelated products when the sparse bound fails", async () => {
        product({ id: "source" });
        const peers = Array.from({ length: 20 }, (_, index) => `weak_${index}`);
        for (const id of peers) product({ id, priceMinor: 300_000 });
        for (const id of ["outside_a", "outside_b", "outside_c"]) product({ id, createdAt: NOW - 10 });
        for (const id of ["source", ...peers]) attribute(id, "attr_weak", "same");
        // Raw relation IDs may contain NULL; the eligible-affinity exclusion cannot.
        collection("col_null", { source: "manual", productIds: ["source", null] });
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const result = await rankProductRecommendations(db, { productIds: ["source"], limit: 3 });
        expect(result.rows.map(row => row.id)).toEqual(["outside_a", "outside_b", "outside_c"]);
        const query = statements[0]!;
        const params = statementParams[0]!;
        expect(sqlite.prepare(query).all(...params)).toEqual(sqlite.prepare(fullUniverseRanking(query, 3)).all(...params));
        const visits = affinityVisits(query, params);
        expect(visits.guard).toEqual([0]);
        expect(visits.scored[0].sort()).toEqual(peers.sort());
        expect(visits.scored[1].sort()).toEqual(["outside_a", "outside_b", "outside_c"]);
    });

    it("rejects an exact (zero co-buy tier, fifteen affinity) bound so outside popularity can win", async () => {
        product({ id: "source" });
        for (const id of ["peer_a", "peer_b"]) product({ id });
        product({ id: "outside", createdAt: NOW - 10 });
        // A real order without a buyer contributes peer IDs but no distinct buyer.
        order("", ["source", "peer_a", "peer_b"]);
        for (const buyer of ["global_a", "global_b"]) order(buyer, ["outside"]);
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const result = await rankProductRecommendations(db, { productIds: ["source"], limit: 2 });
        expect(result.rows[0]).toMatchObject({ id: "outside", popularOrdering: 2 });
        const query = statements[0]!;
        const params = statementParams[0]!;
        expect(sqlite.prepare(query).all(...params)).toEqual(sqlite.prepare(fullUniverseRanking(query, 2)).all(...params));
        const visits = affinityVisits(query, params);
        expect(visits.guard).toEqual([0]);
        expect(visits.scored[0].sort()).toEqual(["peer_a", "peer_b"]);
        expect(visits.scored[1]).toEqual(["outside"]);
    });

    it.each([0, 1, 2, 3])("keeps all %i fallback candidates when the requested list is larger", async (count) => {
        product({ id: "source", categoryId: "cat_shirts" });
        for (let index = 0; index < count; index += 1) {
            product({ id: `peer_${index}`, categoryId: "cat_shirts" });
        }
        if (count > 0) {
            for (const buyer of ["buyer_a", "buyer_b"]) order(buyer, ["peer_0"]);
        }
        await rebuildCatalogProjections(db);
        statements = [];
        statementParams = [];
        const { value, dependencies } = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source"], limit: 4 }),
            { strict: true, log: () => {} },
        );
        expect(value.rows).toHaveLength(count);
        expect(sqlite.prepare(statements[0]!).all(...statementParams[0]!))
            .toEqual(sqlite.prepare(fullUniverseRanking(statements[0]!, 4)).all(...statementParams[0]!));
        if (count > 0) expect(value.rows.find((row) => row.id === "peer_0"))
            .toMatchObject({ popularBuyers: 2, popularOrdering: count <= 2 ? 2 : 0 });
        else expect(dependencies.validUntil).toBeNull();
        expect(dependencies.uncacheable).toEqual([]);
        expect(dependencies.coarseTables).toEqual([]);
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
        expect(statements).toHaveLength(3); // ranking, then cards and media
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
        const steps = sqlite.prepare(`EXPLAIN QUERY PLAN ${statements[index]}`).all(...statementParams[index]!);
        const plan = steps.map((step) => String(step.detail));
        expect(plan.join("\n")).not.toMatch(/SEARCH rec_(peer|source)_category USING INDEX categories_public_idx/);
        expect(plan.join("\n")).not.toMatch(/SCAN rec_(peer|source)_product/);
        // Also-bought starts from the source products' latest order lines
        // (newest first, bounded), not from every order of the last year.
        expect(plan.join("\n")).toMatch(/SEARCH rec_source_line_sample USING COVERING INDEX order_items_product_recent_idx \(product_id=\? AND created_at>\?\)/);
        const sample = steps.find((step) => String(step.detail).startsWith("SEARCH rec_source_line_sample "))!;
        expect(steps.filter((step) => step.parent === sample.parent).map((step) => String(step.detail)).join("\n"))
            .not.toMatch(/USE TEMP B-TREE FOR .*ORDER BY/);
    });

    it("stores the live ranking's top rows with a reason each, and reads them by primary key", async () => {
        product({ id: "source", categoryId: "cat_shirts", priceMinor: 100_000 });
        product({ id: "twin", categoryId: "cat_shirts", priceMinor: 100_000, createdAt: NOW - 50 });
        product({ id: "cousin", categoryId: "cat_trousers", priceMinor: 900_000, createdAt: NOW - 40 });
        product({ id: "later_sold_out", categoryId: "cat_shirts", priceMinor: 100_000, createdAt: NOW - 30 });
        order("01711000001", ["source", "cousin"]);
        order("01711000002", ["source", "cousin"]);
        const live = await recommend(["source"]);
        await refreshProductRecommendations(db, ["source"]);

        expect(sqlite.prepare(
            "SELECT recommended_product_id AS id, reason FROM product_recommendations WHERE product_id = 'source' ORDER BY position",
        ).all()).toEqual([
            { id: "cousin", reason: "also_bought" },
            { id: "later_sold_out", reason: "similar" },
            { id: "twin", reason: "similar" },
        ]);
        expect(ids(live)).toEqual(["cousin", "later_sold_out", "twin"]);

        // A recommended product that sells out keeps its stored row; the read
        // drops it by its current buyer state.
        sqlite.exec("UPDATE product_variants SET stock = 0 WHERE product_id = 'later_sold_out'");
        const stored = await recommend(["source"]);
        expect(ids(stored)).toEqual(["cousin", "twin"]);
        expect(stored.reason).toBe("also_bought"); // one of the two shown is a co-purchase
        expect(statements).toHaveLength(2); // the stored rows, then card media
        const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${statements[0]}`)
            .all(...statementParams[0]!)
            .map((step) => String(step.detail))
            .join("\n");
        expect(plan).toMatch(/SEARCH product_recommendations USING (INDEX sqlite_autoindex_product_recommendations_1|PRIMARY KEY) \(product_id=\?\)/);
        expect(plan).not.toMatch(/SCAN /);
    });

    it("clears a hidden product's stored list and leaves a trashed source to the live fallback", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "peer", categoryId: "cat_shirts" });
        await rebuildCatalogProjections(db);
        await refreshProductRecommendations(db, ["source"]);
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_recommendations").get()).toEqual({ n: 1 });

        sqlite.exec("UPDATE products SET is_active = 0 WHERE id = 'source'");
        await rebuildCatalogProjections(db);
        await expect(refreshProductRecommendations(db, ["source"])).resolves.toEqual({ refreshed: 0, cleared: 1 });
        expect(sqlite.prepare("SELECT count(*) AS n FROM product_recommendations").get()).toEqual({ n: 0 });
    });

    it("ships ranked recommendations on the product page payload", async () => {
        product({ id: "source", categoryId: "cat_shirts" });
        product({ id: "neighbour", categoryId: "cat_shirts", photos: 2 });

        await rebuildCatalogProjections(db);
        const detail = await getStorefrontProductBySlug(db, "source");

        expect(detail?.recommendations.reason).toBe("similar");
        expect(detail?.recommendations.products.map((item) => item.id)).toEqual(["neighbour"]);
        expect(detail?.recommendations.products[0]?.secondaryImageUrl).toContain("media_neighbour_1");
    });
});
