// PostgreSQL parity for the catalogue projections and their readers: the
// refresh statements, the rebuild, the buyer-state listings, the sitemap,
// sales stats and stored recommendations run through the fail-closed SQLite
// profile compiler on a real PostgreSQL server, and give the same answers as
// on D1. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server; the
// test creates and drops its own database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { closeNativePostgres, createNativePostgres, nativePostgresUrl, NATIVE_POSTGRES_TEST_TIMEOUT } from "@scalius/database/testing/postgres-native";
import { productBuyerState, productFacetValues } from "@scalius/database/schema";
import { asc, is, sql, SQL, StringChunk } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

import { createProduct } from "../product-admin/write";
import { deleteProduct, restoreProduct } from "../product-admin/lifecycle";
import { createProductSchema } from "../product-admin/validation";
import { updateProductSemanticSection } from "../product-admin/semantic-sections";
import { rebuildCatalogProjections } from "./catalog-projections";
import { adjustStock } from "../inventory/stock-adjustment";
import { getStorefrontCategoryProducts, getStorefrontCollectionProducts, getStorefrontProducts } from "../catalog/listing";
import { getStorefrontSitemapProducts } from "../catalog/sitemap";
import { resolvePublicAttributeFilters } from "../catalog/facets";
import { getStorefrontProductComparison } from "../catalog/compare";
import {
    refreshProductRecommendations,
    refreshProductSalesStats,
} from "../catalog/recommendation-refresh";
import { getStorefrontProductRecommendations, rankProductRecommendations, rankRecommendationRows } from "../catalog/recommendations";
import { withDependencyScope } from "../../cache-deps";

vi.mock("../inventory/alerts", async (importOriginal) => ({
    ...await importOriginal<typeof import("../inventory/alerts")>(),
    checkAndAlertLowStock: vi.fn(async () => ({ isLow: false, alertCreated: false })),
}));

const postgresUrl = nativePostgresUrl();

afterAll(closeNativePostgres);

const base = {
    description: "A product for the PostgreSQL projection parity test.",
    discountType: "percentage" as const,
    discountPercentage: 0,
    discountAmount: 0,
    freeDelivery: false,
    metaTitle: null,
    metaDescription: null,
    canonicalPath: null,
    noIndex: false,
    excludeFromSitemap: false,
    productCondition: "new" as const,
    media: [],
    additionalInfo: [],
};

describe.runIf(postgresUrl)("catalogue projections on PostgreSQL", { timeout: NATIVE_POSTGRES_TEST_TIMEOUT }, () => {
    it("pages fallback search relevance before projecting cards with exact tiers and ties", async () => {
        const { db, client } = await createNativePostgres({ label: "listing_relevance" });
        await client.query(`INSERT INTO categories (id, name, slug, status) VALUES
            ('cat_other', 'Other', 'other', 'published'),
            ('cat_alpha', 'Alpha group', 'alpha-group', 'published'),
            ('cat_draft', 'Alpha private', 'alpha-private', 'draft')`);
        for (const [id, name, description, category, createdAt, active] of [
            ["title_new", "Alpha", "", "cat_other", 200, 1],
            ["title_a", "Alpha", "", "cat_other", 100, 1],
            ["title_b", "Alpha", "", "cat_other", 100, 1],
            ["category_a", "Kilo", "", "cat_alpha", 100, 1],
            ["category_b", "Lima", "", "cat_alpha", 100, 1],
            ["description", "Zulu", "Alpha description", "cat_other", 300, 1],
            ["inactive", "Alpha", "", "cat_alpha", 400, 0],
            ["draft_category", "Hidden", "", "cat_draft", 400, 1],
        ] as const) {
            await client.query(`INSERT INTO products
                (id, name, description, price_minor, category_id, slug, created_at, updated_at, is_active)
                VALUES ($1, $2, $3, 100000, $4, $1, $5, $5, $6)`,
            [id, name, description, category, createdAt, active]);
            await client.query(`INSERT INTO product_variants
                (id, product_id, sku, price_minor, stock, is_default, track_inventory)
                VALUES ($1, $2, $1, 100000, 0, 1, 0)`, [`var_${id}`, id]);
        }
        await rebuildCatalogProjections(db);
        const expected = ["title_new", "title_a", "title_b", "category_a", "category_b", "description"];
        const seen: string[] = [];
        for (const page of [1, 2, 3]) {
            const { value, dependencies } = await withDependencyScope(
                () => getStorefrontProducts(db, { search: "alpha", page, limit: 2 }),
                { strict: true, log: () => {} },
            );
            const ids = value.products.map(product => product.id);
            expect(ids).toEqual(expected.slice((page - 1) * 2, page * 2));
            expect(value.pagination).toMatchObject({ page, limit: 2, total: 6, totalPages: 3 });
            expect(dependencies.uncacheable).toEqual([]);
            expect(dependencies.coarseTables).toEqual([]);
            seen.push(...ids);
        }
        expect(seen).toEqual(expected);
        await client.query(`INSERT INTO product_review_stats
            (product_id, review_count, rating_sum, count_1, count_3, count_5, rating_avg_centi, rating_rank_milli)
            VALUES ('title_new', 1, 5, 0, 0, 1, 500, 3333),
                ('category_a', 1, 3, 0, 1, 0, 300, 3000),
                ('description', 1, 1, 1, 0, 0, 100, 2666)`);
        const rated = await getStorefrontProducts(db, { search: "alpha", minRating: 4, limit: 20 });
        expect(rated.products.map(product => product.id)).toEqual(["title_new"]);
        expect(rated.ratingFacet).toEqual([{ min: 4, count: 1 }, { min: 3, count: 2 }, { min: 2, count: 2 }]);
        const oneStar = await getStorefrontProducts(db, { search: "alpha", minRating: 1, limit: 20 });
        expect(oneStar.ratingFacet).toEqual([
            { min: 4, count: 1 }, { min: 3, count: 2 }, { min: 2, count: 2 }, { min: 1, count: 3 },
        ]);
    });

    it("keeps populated recommendation scores and strict deadlines through the hinted order joins", async () => {
        const { db, client } = await createNativePostgres({ label: "recommendation_buyers" });
        const now = Number((await client.query("SELECT unixepoch() AS now")).rows[0].now);
        await client.query(`INSERT INTO categories (id, name, slug, status) VALUES
            ('cat_shirts', 'Shirts', 'shirts', 'published'), ('cat_trousers', 'Trousers', 'trousers', 'published')`);
        for (const [id, category, price, stock, active] of [
            ["source", "cat_shirts", 100_000, 5, 1], ["peer", "cat_trousers", 900_000, 5, 1],
            ["similar", "cat_shirts", 100_000, 5, 1], ["sold_out", null, 100_000, 0, 1],
            ["hidden", null, 100_000, 5, 0],
        ] as const) {
            await client.query(`INSERT INTO products
                (id, name, description, price_minor, category_id, slug, is_active, created_at, updated_at)
                VALUES ($1, $1, '', $2, $3, $1, $4, $5, $5)`, [id, price, category, active, now - 86_400]);
            await client.query(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
                VALUES ($1, $2, $1, $3, $4, 1, 1)`, [`var_${id}`, id, price, stock]);
        }
        const basket = ["source", "source", "peer", "sold_out", "hidden"];
        const order = async (id: string, phone: string, email: string | null, status: string, createdAt = now - 3_600) => {
            await client.query(`INSERT INTO orders
                (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, status, created_at, updated_at)
                VALUES ($1, 'Buyer', $2, $3, 'Road', 'city', 'zone', $4, $5, $5)`, [id, phone, email, status, createdAt]);
            await client.query(`INSERT INTO order_items (id, order_id, product_id, quantity, created_at)
                SELECT $1 || '_line_' || line.ordinality, $1, line.product_id, 1, $3
                FROM unnest($2::text[]) WITH ORDINALITY AS line(product_id, ordinality)`, [id, basket, createdAt]);
        };
        await order("phone_pending", "01711111111", null, "pending");
        await order("phone_delivered", "01711111111", null, "delivered");
        await order("email_processing", "NO_PHONE", "buyer@example.com", "processing");
        await order("email_confirmed", "NO_PHONE", " BUYER@EXAMPLE.COM ", "confirmed");
        await order("older_buyer", "01722222222", null, "completed", now - 40 * 86_400);
        for (const status of ["cancelled", "incomplete", "refunded", "returned"]) {
            await order(`excluded_${status}`, `excluded_${status}`, null, status);
        }
        await order("deleted_buyer", "01733333333", null, "confirmed");
        await client.query("UPDATE orders SET deleted_at = $1 WHERE id = 'deleted_buyer'", [now]);
        await rebuildCatalogProjections(db);
        const ranked = () => withDependencyScope(
            () => rankProductRecommendations(db, { productIds: ["source"], limit: 8 }),
            { strict: true, log: () => {} },
        );
        const { value, dependencies } = await ranked();
        expect(value).toEqual({ reason: "also_bought", rows: [
            { id: "peer", alsoBoughtBuyers: 3, relatedScore: 0, popularBuyers: 2, popularOrdering: 2 },
            { id: "similar", alsoBoughtBuyers: 0, relatedScore: 40, popularBuyers: 0, popularOrdering: 0 },
        ] });
        expect(dependencies.validUntil).toBe((now - 3_600 + 30 * 86_400 + 1) * 1_000);
        expect(dependencies.keys).toContain("recommendation-signals");
        expect(dependencies.uncacheable).toEqual([]);
        expect(dependencies.coarseTables).toEqual([]);
        // The annual source-order boundary can win without changing any scores.
        await client.query("UPDATE orders SET created_at = $1 WHERE id = 'older_buyer'", [now - 365 * 86_400 + 100]);
        const annual = await ranked();
        expect(annual.value).toEqual(value);
        expect(annual.dependencies.validUntil).toBe((now + 101) * 1_000);
        await client.query("UPDATE products SET is_active = 0");
        await rebuildCatalogProjections(db);
        const rawAll = vi.spyOn(db, "all");
        const empty = await ranked();
        expect(rawAll).toHaveBeenCalledTimes(1);
        rawAll.mockRestore();
        expect(empty.value.rows).toEqual([]);
        expect(empty.dependencies.validUntil).toBe(annual.dependencies.validUntil);
        const noSource = await withDependencyScope(
            () => rankProductRecommendations(db, { productIds: [] }), { strict: true, log: () => {} },
        );
        expect(noSource.value.rows).toEqual([]);
        expect(noSource.dependencies.validUntil).toBe(dependencies.validUntil);
    });

    it("preserves the global quorum and all cutoff ties for a qualifying 24-row refresh", async () => {
        const { db, client } = await createNativePostgres({ label: "recommendation_winners" });
        const now = Number((await client.query("SELECT unixepoch() AS now")).rows[0].now);
        const peers = Array.from({ length: 25 }, (_, index) => `peer_${String(index).padStart(2, "0")}`);
        const witnesses = Array.from({ length: 12 }, (_, index) => `witness_${index}`);
        const productIds = ["source", ...peers, ...witnesses];
        await client.query(`INSERT INTO products
            (id, name, description, price_minor, slug, is_active, created_at, updated_at)
            SELECT item.id, item.id, '', 100000, item.id, 1, $2 + item.ordinality, $2 + item.ordinality
            FROM unnest($1::text[]) WITH ORDINALITY AS item(id, ordinality)`, [productIds, now - 100]);
        await client.query(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
            SELECT 'var_' || id, id, 'sku_' || id, 100000, 5, 1, 1 FROM unnest($1::text[]) AS item(id)`, [productIds]);
        const order = async (id: string, basket: string[], phone: string, email: string | null,
            createdAt: number, lineCreatedAt = now - 3600, status = "completed") => {
            await client.query(`INSERT INTO orders
                (id, customer_name, customer_phone, customer_email, shipping_address, city, zone, status, created_at, updated_at)
                VALUES ($1, 'Buyer', $2, $3, 'Road', 'city', 'zone', $4, $5, $5)`, [id, phone, email, status, createdAt]);
            await client.query(`INSERT INTO order_items (id, order_id, product_id, quantity, created_at)
                SELECT $1 || '_line_' || line.ordinality, $1, line.product_id, 1, $3
                FROM unnest($2::text[]) WITH ORDINALITY AS line(product_id, ordinality)`, [id, basket, lineCreatedAt]);
        };
        for (let buyer = 0; buyer < 4; buyer += 1) {
            await order(`annual_${buyer}`, ["source", "source", ...peers], `annual_${buyer}`, null, now - 40 * 86400);
        }
        await order("recent_phone", ["source", ...witnesses], "01711111111", null, now - 3600);
        await order("recent_email", ["source", ...witnesses], "NO_PHONE", "buyer@example.com", now - 3600);
        await order("recent_email_repeat", ["source", ...witnesses], "NO_PHONE", " BUYER@EXAMPLE.COM ", now - 3600);
        // Popularity follows the order time even when a line's time is old.
        for (const buyer of ["popular_a", "popular_b"]) {
            await order(buyer, [peers[0]!], buyer, null, now - 3600, now - 400 * 86400);
        }
        for (const status of ["cancelled", "incomplete", "refunded", "returned"]) {
            await order(`excluded_${status}`, ["source", ...peers], status, null, now - 3600, now - 3600, status);
        }
        await order("deleted", ["source", ...peers], "deleted", null, now - 3600);
        await client.query("UPDATE orders SET deleted_at = $1 WHERE id = 'deleted'", [now]);
        await rebuildCatalogProjections(db);
        const rawAll = vi.spyOn(db, "all");
        const { value: rows, dependencies } = await withDependencyScope(
            () => rankRecommendationRows(db, ["source"], 24), { strict: true, log: () => {} },
        );
        const expectedIds = [peers[0]!, ...peers.slice(2).reverse()];
        expect(rows).toEqual(expectedIds.map((id) => ({
            id, alsoBoughtBuyers: 4, relatedScore: 0,
            popularBuyers: id === peers[0] ? 2 : 0, popularOrdering: id === peers[0] ? 2 : 0,
        })));
        expect(dependencies.validUntil).toBe((now - 3600 + 30 * 86400 + 1) * 1000);
        expect(dependencies.uncacheable).toEqual([]);
        expect(dependencies.coarseTables).toEqual([]);
        expect(rawAll).toHaveBeenCalledTimes(1);
        const captured = rawAll.mock.calls.at(-1)![0] as SQL;
        rawAll.mockRestore();
        const forceCanonical = (statement: SQL): SQL => new SQL(statement.queryChunks.map((chunk) => {
            if (is(chunk, SQL)) return forceCanonical(chunk);
            return is(chunk, StringChunk)
                ? new StringChunk(chunk.value.map((text) => text.replace("SELECT CASE WHEN COUNT(*) >=", "SELECT CASE WHEN 0 = 1 AND COUNT(*) >=")))
                : chunk;
        }));
        const canonical = forceCanonical(captured);
        const dialect = new SQLiteSyncDialect();
        expect(dialect.sqlToQuery(canonical).sql).not.toBe(dialect.sqlToQuery(captured).sql);
        const canonicalRows = await db.all<Record<string, unknown>>(canonical);
        expect(canonicalRows.map((row) => ({
            id: row.id, alsoBoughtBuyers: row.alsoBoughtBuyers, relatedScore: row.relatedScore,
            popularBuyers: row.popularBuyers, popularOrdering: row.popularOrdering,
        }))).toEqual(rows);
        expect(canonicalRows.every((row) => Number(row.popularAt) * 1000 === dependencies.validUntil)).toBe(true);
        // Reuse the shared CTE interpolation before the limited ranking and
        // deadline wrapper to prove this provider takes the qualifying path.
        const rankingCtes = captured.queryChunks.find((chunk) => is(chunk, SQL)
            && dialect.sqlToQuery(chunk).sql.includes("WITH rec_source_orders AS MATERIALIZED")) as SQL;
        expect(dialect.sqlToQuery(rankingCtes).sql).toContain("WITH rec_source_orders AS MATERIALIZED");
        const guard = new SQL([rankingCtes]).append(sql`
            SELECT qualifies, (SELECT COUNT(*) FROM rec_eligible_co) AS eligible,
                (SELECT COUNT(*) FROM rec_winning_co) AS winners FROM rec_guard`);
        expect(await db.all(guard))
            .toEqual([{ qualifies: 1, eligible: 37, winners: 25 }]);
        await expect(refreshProductRecommendations(db, ["source"])).resolves.toEqual({ refreshed: 1, cleared: 0 });
        expect((await client.query("SELECT recommended_product_id AS id FROM product_recommendations WHERE product_id = 'source' ORDER BY position")).rows)
            .toEqual(expectedIds.map((id) => ({ id })));
    });

    it("keeps and reads the buyer state and facet rows like D1", async () => {
        const { db, client } = await createNativePostgres({ label: "projections" });
        await client.query(`
            INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Shirts', 'shirts', 'published');
            INSERT INTO product_attributes (id, name, slug, filterable) VALUES ('attr_material', 'Material', 'material', 1);
            INSERT INTO brands (id, name, slug, status) VALUES ('brd_walton01', 'Walton', 'walton', 'published');
        `);
        const simple = await createProduct(db, createProductSchema.parse({
            ...base, name: "Linen shirt", categoryId: "cat_a", brandId: "brd_walton01", isActive: true, price: 250,
            attributes: [{ attributeId: "attr_material", value: " Linen " }],
            defaultSku: { sku: "PG-LINEN", trackInventory: true, stock: 2 },
        }));
        const optioned = await createProduct(db, createProductSchema.parse({
            ...base, name: "Cotton tee", categoryId: "cat_a", isActive: true, price: 180, discountPercentage: 10, attributes: [],
            optionMatrix: {
                options: [{ id: "draft_size", name: "Size", standardMapping: "size", values: [
                    { id: "draft_s", value: "S" }, { id: "draft_m", value: "M" },
                ] }],
                variants: [
                    { id: "draft_v_s", selectedOptionValueIds: ["draft_s"], imageId: null, sku: "PG-TEE-S", price: 180, stock: 0, trackInventory: true, weight: null, barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: null, discountAmount: null },
                    { id: "draft_v_m", selectedOptionValueIds: ["draft_m"], imageId: null, sku: "PG-TEE-M", price: 200, stock: 3, trackInventory: true, weight: null, barcode: null, barcodeType: null, discountType: "percentage", discountPercentage: null, discountAmount: null },
                ],
            },
        }));
        // Pin the intentional ID tie before the writes below refresh each projection.
        await client.query("UPDATE products SET created_at = 1700000000 WHERE id = ANY($1::text[])", [[simple.id, optioned.id]]);
        const skuOf = async (sku: string) => (await client.query("SELECT id FROM product_variants WHERE sku = $1", [sku])).rows[0].id as string;
        await adjustStock(db, await skuOf("PG-LINEN"), -2, `pg_${randomUUID()}`);
        const revision = async (id: string) => Number((await client.query("SELECT aggregate_revision FROM products WHERE id = $1", [id])).rows[0].aggregate_revision);
        await updateProductSemanticSection(db, optioned.id, {
            section: "base", expectedAggregateRevision: await revision(optioned.id), patch: { discountPercentage: 20, discountType: "percentage" },
        });
        await deleteProduct(db, simple.id, await revision(simple.id));
        await restoreProduct(db, simple.id, await revision(simple.id));

        const state = await db.select().from(productBuyerState).orderBy(asc(productBuyerState.productId));
        const byId = new Map(state.map((row) => [row.productId, row]));
        expect(byId.get(simple.id)).toMatchObject({
            isPublic: true, brandId: "brd_walton01", fromMinor: 25_000, availableForSale: false,
            availabilityBand: "out_of_stock", hasCustomerOptions: false,
        });
        expect(byId.get(optioned.id)).toMatchObject({
            isPublic: true, fromMinor: 16_000, toMinor: 16_000, baseMinor: 20_000, discountDepthBps: 2_000,
            hasDiscount: true, availableForSale: true, hasCustomerOptions: true, availabilityBand: "in_stock",
        });
        const facets = await db.select().from(productFacetValues).orderBy(asc(productFacetValues.ownerId), asc(productFacetValues.facetKey));
        expect(facets.map((row) => [row.facetKind, row.facetKey, row.valueKey, row.valueLabel])).toEqual(expect.arrayContaining([
            ["attribute", "attr_material", "linen", "Linen"],
            ["option", "option.size", "s", "S"],
            ["option", "option.size", "m", "M"],
        ]));

        // Typed values (1b writes these): canonical number and boolean keys.
        await client.query(`
            INSERT INTO product_attributes (id, name, slug, filterable, value_type, unit, facet_display) VALUES
                ('attr_display', 'Display', 'display', 1, 'number', 'in', 'range'),
                ('attr_wifi', 'Wi-Fi', 'wifi', 1, 'boolean', NULL, 'checkbox');
            INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id, value_number) VALUES
                ('pav_pg_1', '${simple.id}', 'attr_display', '15.60 in', NULL, 15.6),
                ('pav_pg_2', '${simple.id}', 'attr_wifi', 'Yes', NULL, 1),
                ('pav_pg_3', '${optioned.id}', 'attr_display', '1000 in', NULL, 1000);
        `);

        // The rebuild recomputes the same buyer-state rows (and the new facets).
        const before = JSON.stringify(state.map(({ refreshedAt: _r, ...row }) => row));
        let cursor: string | null = null;
        for (;;) {
            const chunk = await rebuildCatalogProjections(db, { afterProductId: cursor, limit: 1 });
            if (chunk.done) break;
            cursor = chunk.nextAfterProductId;
        }
        const after = await db.select().from(productBuyerState).orderBy(asc(productBuyerState.productId));
        expect(JSON.stringify(after.map(({ refreshedAt: _r, ...row }) => row))).toBe(before);

        // Migration 0091's PostgreSQL sidecar fills the same rows from empty tables.
        const facetRows = async () => JSON.stringify((await client.query("SELECT * FROM product_facet_values ORDER BY owner_id, facet_key")).rows);
        const rebuiltFacets = await facetRows();
        await client.query("DELETE FROM product_buyer_state; DELETE FROM product_facet_values;");
        const sidecar = readFileSync(fileURLToPath(new URL(
            "../../../../database/migrations/postgres/0091_catalogue_projection_fill.sql", import.meta.url,
        )), "utf8").split("--> statement-breakpoint").slice(0, -1);
        for (const statement of sidecar) await client.query(statement);
        const filled = await db.select().from(productBuyerState).orderBy(asc(productBuyerState.productId));
        expect(JSON.stringify(filled.map(({ refreshedAt: _r, ...row }) => row))).toBe(before);
        expect(await facetRows()).toBe(rebuiltFacets);
        const typed = await client.query(
            "SELECT facet_key, value_key, value_number FROM product_facet_values WHERE facet_key IN ('attr_display', 'attr_wifi') ORDER BY value_key",
        );
        expect(typed.rows).toEqual([
            { facet_key: "attr_wifi", value_key: "1", value_number: 1 },
            { facet_key: "attr_display", value_key: "1000", value_number: 1000 },
            { facet_key: "attr_display", value_key: "15.6", value_number: 15.6 },
        ]);

        // Readers.
        const newest = await getStorefrontProducts(db, { page: 1, limit: 10 });
        // Pinned to the same creation time: ties break by product id.
        expect(newest.products.map((product) => product.id)).toEqual([simple.id, optioned.id].sort());
        expect(newest.products.find((product) => product.id === optioned.id))
            .toMatchObject({ price: 200, discountedPrice: 160, priceVaries: false, hasVariants: true });
        const cheapest = await getStorefrontProducts(db, { page: 1, limit: 10, sort: "price-asc" });
        expect(cheapest.products.map((product) => product.id)).toEqual([optioned.id, simple.id]);
        const category = await getStorefrontCategoryProducts(db, {
            id: "cat_a", name: "Shirts", slug: "shirts", description: null, imageUrl: null, metaTitle: null,
            metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null,
        }, { page: 1, limit: 10, attributeFilters: [{ kind: "option", id: "option.size", name: "Size", slug: "option.size", values: ["m"], keys: ["m"] }] });
        expect(category.products.map((product) => product.id)).toEqual([optioned.id]);
        // Typed facet filters and counts (catalog/facets.ts) compile and agree on PostgreSQL.
        const shirts = {
            id: "cat_a", name: "Shirts", slug: "shirts", description: null, imageUrl: null, metaTitle: null,
            metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null, updatedAt: null,
        };
        const typedFilters = await resolvePublicAttributeFilters(db, {
            brand: ["Walton"], material: ["LINEN"], "display.min": ["10"], "display.max": ["20"], wifi: ["yes"],
        }, []);
        expect(typedFilters.map((filter) => [filter.kind, filter.id, filter.keys])).toEqual([
            ["brand", "brand", ["brd_walton01"]],
            ["attribute", "attr_material", ["linen"]],
            ["attribute", "attr_wifi", ["1"]],
            ["attribute", "attr_display", []],
        ]);
        const typedListing = await getStorefrontCategoryProducts(db, shirts, { page: 1, limit: 10, attributeFilters: typedFilters });
        expect(typedListing.products.map((product) => product.id)).toEqual([simple.id]);
        const facetsBySlug = Object.fromEntries(typedListing.facets.map((facet) => [facet.slug, facet]));
        expect(facetsBySlug.brand?.values).toEqual([{ value: "walton", label: "Walton", count: 1, swatch: null }]);
        expect(facetsBySlug.display).toMatchObject({ display: "range", unit: "in", range: { min: 15.6, max: 15.6 } });
        expect(facetsBySlug["option.size"]?.values.map((value) => [value.value, value.count])).toEqual([["s", 0], ["m", 0]]);
        const comparison = await getStorefrontProductComparison(db, [optioned.id, simple.id]);
        expect(comparison.products.map((product) => product.id)).toEqual([optioned.id, simple.id]);
        expect(comparison.groups[0]?.rows.find((row) => row.slug === "display")?.values).toEqual(["1000 in", "15.60 in"]);
        const collection = await getStorefrontCollectionProducts(db, { productIds: [simple.id] }, { page: 1, limit: 10 });
        expect(collection.products.map((product) => product.id)).toEqual([simple.id]);
        const sitemap = await getStorefrontSitemapProducts(db, { page: 1, limit: 10 });
        expect(sitemap.pagination.total).toBe(2);

        await expect(refreshProductSalesStats(db)).resolves.toEqual({ products: 0 });
        await expect(refreshProductRecommendations(db, [optioned.id])).resolves.toEqual({ refreshed: 1, cleared: 0 });
        // The linen shirt is sold out: stored, but not shown.
        const stored = await getStorefrontProductRecommendations(db, { productIds: [optioned.id] });
        expect(stored.products).toEqual([]);
        const live = await getStorefrontProductRecommendations(db, { productIds: [] });
        expect(live.products.map((product) => product.id)).toEqual([optioned.id]);
    });
});
