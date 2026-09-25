// PostgreSQL parity for the catalogue projections and their readers: the
// refresh statements, the rebuild, the buyer-state listings, the sitemap,
// sales stats and stored recommendations run through the fail-closed SQLite
// profile compiler on a real PostgreSQL server, and give the same answers as
// on D1. Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server; the
// test creates and drops its own database.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { connectPostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import type { Database } from "@scalius/database/client";
import { productBuyerState, productFacetValues } from "@scalius/database/schema";
import { asc } from "drizzle-orm";

import { createProduct } from "./admin/write";
import { deleteProduct, restoreProduct } from "./admin/lifecycle";
import { createProductSchema } from "./validation";
import { updateProductSemanticSection } from "./semantic-sections";
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
import { getStorefrontProductRecommendations } from "../catalog/recommendations";

vi.mock("../inventory/alerts", async (importOriginal) => ({
    ...await importOriginal<typeof import("../inventory/alerts")>(),
    checkAndAlertLowStock: vi.fn(async () => ({ isLow: false, alertCreated: false })),
}));

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

/** The canonical PostgreSQL schema, compiled by the database package's own script. */
function canonicalPostgresSchemaSql(): string {
    const databaseDir = fileURLToPath(new URL("../../../../database/", import.meta.url));
    const out = join(mkdtempSync(join(tmpdir(), "scalius-pg-schema-")), "schema.sql");
    const tsx = fileURLToPath(new URL("../../../../../apps/api/node_modules/.bin/tsx", import.meta.url));
    execFileSync(tsx, ["scripts/postgres-schema.ts", "--out", out], { cwd: databaseDir });
    return readFileSync(out, "utf8");
}
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function freshDatabase(): Promise<{ db: Database; client: Client }> {
    const name = `scalius_projections_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: postgresUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(canonicalPostgresSchemaSql());
    const db = createPostgresDatabase(url.toString(), { connect: connectPostgres });
    cleanups.push(async () => {
        await client.end();
        await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
        await admin.end();
    });
    return { db, client };
}

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
    excludeFromProductFeed: false,
    productCondition: "new" as const,
    media: [],
    additionalInfo: [],
};

describe.runIf(postgresUrl)("catalogue projections on PostgreSQL", () => {
    it("keeps and reads the buyer state and facet rows like D1", async () => {
        const { db, client } = await freshDatabase();
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
        // Created in the same second: ties break by product id.
        expect(newest.products.map((product) => product.id)).toEqual([simple.id, optioned.id].sort());
        expect(newest.products.find((product) => product.id === optioned.id))
            .toMatchObject({ price: 200, discountedPrice: 160, priceVaries: false, hasVariants: true });
        const cheapest = await getStorefrontProducts(db, { page: 1, limit: 10, sort: "price-asc" });
        expect(cheapest.products.map((product) => product.id)).toEqual([optioned.id, simple.id]);
        const category = await getStorefrontCategoryProducts(db, {
            id: "cat_a", name: "Shirts", slug: "shirts", description: null, imageUrl: null, metaTitle: null,
            metaDescription: null, canonicalPath: null, noIndex: false, excludeFromSitemap: false, createdAt: null, updatedAt: null,
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
