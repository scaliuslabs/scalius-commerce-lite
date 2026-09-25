import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import type { Database } from "@scalius/database/client";
import { afterEach, describe, expect, it } from "vitest";

import { ConflictError, ValidationError } from "@scalius/core/errors";
import { createBrandSchema, updateBrandSchema } from "./brands.validation";
import {
    BrandRevisionConflictError,
    BrandStateConflictError,
    createBrand,
    getBrandById,
    listBrandOptions,
    listBrands,
    permanentlyDeleteBrands,
    restoreBrands,
    trashBrands,
    updateBrand,
    updateBrandStatus,
} from "./brands.service";
import { getPublicBrandBySlug, getPublicBrandSitemapEntries, listPublicBrands } from "./brands.storefront";
import { getStorefrontBrandProducts } from "../catalog/listing";
import { getStorefrontProductBySlug } from "../catalog/product-page";
import { getStorefrontFeedProducts } from "../catalog/feed";

type Captured = { sql: string; params: readonly SQLInputValue[] };

let sqlite: DatabaseSync | null = null;
afterEach(() => {
    sqlite?.close();
    sqlite = null;
});

function database(onQuery?: (sql: string, params: readonly SQLInputValue[]) => void) {
    const harness = createSqliteD1Database(onQuery ? { onQuery } : {});
    sqlite = harness.sqlite;
    sqlite.exec(`
        INSERT INTO media (id, filename, kind, object_key, size, mime_type, status, trashed_at) VALUES
            ('med_logo', 'logo.png', 'image', 'media/logo.png', 1, 'image/png', 'ready', NULL),
            ('med_trashed', 'old.png', 'image', 'media/old.png', 1, 'image/png', 'trashed', unixepoch()),
            ('med_video', 'clip.mp4', 'video', 'media/clip.mp4', 1, 'video/mp4', 'ready', NULL);
    `);
    return harness.db;
}

function input(name: string, extra: Record<string, unknown> = {}) {
    return createBrandSchema.parse({ name, ...extra });
}

async function publishedBrand(db: Database, name: string, extra: Record<string, unknown> = {}) {
    return createBrand(db, input(name, { status: "published", ...extra }));
}

describe("brand records", () => {
    it("creates drafts with a slug derived from the name, short names included", async () => {
        const db = database();
        const hp = await createBrand(db, input("HP"));
        const again = await createBrand(db, input("hp"));
        const walton = await createBrand(db, input("Walton Hi-Tech", { logoMediaId: "med_logo" }));

        expect(hp).toMatchObject({ slug: "hp", revision: 1, status: "draft" });
        expect(again.slug).toBe("hp-2");
        expect(walton.slug).toBe("walton-hi-tech");
        expect(hp.id).toMatch(/^brd_/);
        await expect(createBrand(db, input("Other", { slug: "hp" }))).rejects.toBeInstanceOf(ConflictError);

        const detail = await getBrandById(db, walton.id);
        expect(detail).toMatchObject({ logoMediaId: "med_logo", productCount: 0, listingTemplate: null });
        expect(detail?.logo).toMatchObject({ mediaId: "med_logo", alt: "Walton Hi-Tech" });
    });

    it("accepts only a ready image as a newly chosen logo", async () => {
        const db = database();
        await expect(createBrand(db, input("A", { logoMediaId: "med_trashed" }))).rejects.toBeInstanceOf(ValidationError);
        await expect(createBrand(db, input("B", { logoMediaId: "med_video" }))).rejects.toBeInstanceOf(ValidationError);
        await expect(createBrand(db, input("C", { logoMediaId: "med_missing" }))).rejects.toBeInstanceOf(ValidationError);
        expect(sqlite!.prepare("SELECT count(*) AS rows FROM brands").get()).toEqual({ rows: 0 });

        const brand = await createBrand(db, input("D"));
        await expect(updateBrand(db, brand.id, updateBrandSchema.parse({
            name: "D", slug: brand.slug, status: "draft", expectedRevision: 1, logoMediaId: "med_trashed",
        }))).rejects.toBeInstanceOf(ValidationError);
        expect(sqlite!.prepare("SELECT revision FROM brands WHERE id = ?").get(brand.id)).toEqual({ revision: 1 });
    });

    it("edits under the revision and keeps omitted optional fields", async () => {
        const db = database();
        const brand = await createBrand(db, input("Walton", { logoMediaId: "med_logo", sortOrder: 4, listingTemplate: "spec-grid" }));

        await expect(updateBrand(db, brand.id, updateBrandSchema.parse({
            name: "Walton BD", slug: "walton-bd", status: "published", expectedRevision: 1,
            canonicalPath: "/brands/walton-bd",
        }))).resolves.toEqual({ revision: 2, status: "published" });
        await expect(updateBrand(db, brand.id, updateBrandSchema.parse({
            name: "Stale", slug: "stale", status: "draft", expectedRevision: 1,
        }))).rejects.toBeInstanceOf(BrandRevisionConflictError);
        expect(await getBrandById(db, brand.id)).toMatchObject({
            name: "Walton BD",
            slug: "walton-bd",
            canonicalPath: "/brands/walton-bd",
            logoMediaId: "med_logo",
            sortOrder: 4,
            listingTemplate: "spec-grid",
            revision: 2,
        });
        await expect(updateBrandStatus(db, brand.id, { expectedRevision: 2, status: "draft" }))
            .resolves.toEqual({ revision: 3, status: "draft" });
    });

    it("rejects a canonical path that is not this brand's own route", () => {
        expect(() => createBrandSchema.parse({ name: "Walton", slug: "walton", canonicalPath: "/brands/other" })).toThrow();
        expect(() => createBrandSchema.parse({ name: "Walton", slug: "walton", canonicalPath: "/categories/walton" })).toThrow();
        expect(createBrandSchema.parse({ name: "Walton", slug: "walton", canonicalPath: " " }).canonicalPath).toBeNull();
    });

    it("trashes as a draft, restores, and deletes only from trash, releasing its products", async () => {
        const db = database();
        const brand = await publishedBrand(db, "Walton");
        sqlite!.exec(`INSERT INTO products (id, name, price_minor, slug, brand_id) VALUES ('prod_fan', 'Fan', 1000, 'fan', '${brand.id}')`);

        await expect(permanentlyDeleteBrands(db, [{ id: brand.id, expectedRevision: 1 }])).rejects.toBeInstanceOf(BrandStateConflictError);
        await trashBrands(db, [{ id: brand.id, expectedRevision: 1 }]);
        expect(await getBrandById(db, brand.id)).toMatchObject({ status: "draft", revision: 2, productCount: 1 });
        await expect(trashBrands(db, [{ id: brand.id, expectedRevision: 2 }])).rejects.toBeInstanceOf(BrandStateConflictError);
        expect((await listBrands(db, { showTrashed: true })).brands.map((row) => row.id)).toEqual([brand.id]);
        expect(await listBrandOptions(db)).toEqual([]);

        await restoreBrands(db, [{ id: brand.id, expectedRevision: 2 }]);
        await trashBrands(db, [{ id: brand.id, expectedRevision: 3 }]);
        const before = sqlite!.prepare("SELECT aggregate_revision AS revision FROM products WHERE id = 'prod_fan'").get() as { revision: number };
        await permanentlyDeleteBrands(db, [{ id: brand.id, expectedRevision: 4 }]);
        expect(sqlite!.prepare("SELECT brand_id AS brandId, aggregate_revision AS revision FROM products WHERE id = 'prod_fan'").get())
            .toEqual({ brandId: null, revision: before.revision + 1 });
    });
});

describe("brand buyer reads", () => {
    async function seed(db: Database) {
        const walton = await publishedBrand(db, "Walton", { logoMediaId: "med_logo", sortOrder: 2 });
        const draft = await createBrand(db, input("Draft brand"));
        const hidden = await publishedBrand(db, "Hidden", { noIndex: true, sortOrder: 1 });
        const trashed = await publishedBrand(db, "Trashed");
        await trashBrands(db, [{ id: trashed.id, expectedRevision: 1 }]);
        sqlite!.exec(`
            INSERT INTO products (id, name, price_minor, slug, brand_id, is_active, created_at) VALUES
                ('prod_fan', 'Ceiling Fan', 450000, 'ceiling-fan', '${walton.id}', 1, 1700000002),
                ('prod_tv', 'Smart TV', 3500000, 'smart-tv', '${walton.id}', 1, 1700000001),
                ('prod_draft', 'Draft brand kettle', 150000, 'draft-kettle', '${draft.id}', 1, 1700000003),
                ('prod_none', 'Unbranded kettle', 150000, 'unbranded-kettle', NULL, 1, 1700000004);
            INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory) VALUES
                ('var_fan', 'prod_fan', 'FAN', 450000, 3, 1, 1),
                ('var_tv', 'prod_tv', 'TV', 3500000, 3, 1, 1),
                ('var_draft', 'prod_draft', 'KETTLE-D', 150000, 3, 1, 1),
                ('var_none', 'prod_none', 'KETTLE-N', 150000, 3, 1, 1);
            INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
                ('med_fan', 'fan.png', 'image', 'media/fan.png', 1, 'image/png', 'ready'),
                ('med_tv', 'tv.png', 'image', 'media/tv.png', 1, 'image/png', 'ready'),
                ('med_draft', 'k.png', 'image', 'media/k.png', 1, 'image/png', 'ready'),
                ('med_none', 'n.png', 'image', 'media/n.png', 1, 'image/png', 'ready');
            INSERT INTO product_media (id, product_id, media_id, is_primary, sort_order) VALUES
                ('pmed_fan01', 'prod_fan', 'med_fan', 1, 0),
                ('pmed_tv001', 'prod_tv', 'med_tv', 1, 0),
                ('pmed_drft1', 'prod_draft', 'med_draft', 1, 0),
                ('pmed_none1', 'prod_none', 'med_none', 1, 0);
        `);
        return { walton, draft, hidden, trashed };
    }

    it("shows only published, live brands and lists them in merchant order", async () => {
        const db = database();
        const { walton } = await seed(db);

        expect(await getPublicBrandBySlug(db, "walton")).toMatchObject({ id: walton.id, logo: { mediaId: "med_logo" } });
        expect(await getPublicBrandBySlug(db, "draft-brand")).toBeNull();
        expect(await getPublicBrandBySlug(db, "trashed")).toBeNull();
        expect((await listPublicBrands(db)).brands.map((brand) => brand.slug)).toEqual(["hidden", "walton"]);
        expect((await getPublicBrandSitemapEntries(db)).map((entry) => entry.slug)).toEqual(["walton"]);
    });

    it("lists a brand's products and puts the published brand on the product page and the feed", async () => {
        const db = database();
        const { walton } = await seed(db);

        const listing = await getStorefrontBrandProducts(db, walton, { page: 1, limit: 20 });
        expect(listing.products.map((product) => product.id)).toEqual(["prod_fan", "prod_tv"]);

        expect((await getStorefrontProductBySlug(db, "ceiling-fan"))?.product.brand)
            .toEqual({ id: walton.id, name: "Walton", slug: "walton", canonicalPath: null });
        expect((await getStorefrontProductBySlug(db, "draft-kettle"))?.product.brand).toBeNull();
        expect((await getStorefrontProductBySlug(db, "unbranded-kettle"))?.product.brand).toBeNull();

        const feed = await getStorefrontFeedProducts(db, { limit: 10 });
        expect(Object.fromEntries(feed.products.map((product) => [product.id, product.brand?.name ?? null]))).toEqual({
            prod_none: null,
            prod_draft: null,
            prod_fan: "Walton",
            prod_tv: "Walton",
        });
    });
});

describe("brand read plans", () => {
    it("reads brands through their indexes with at most 90 bound parameters", async () => {
        const queries: Captured[] = [];
        const db = database((sql, params) => queries.push({ sql, params }));
        const brand = await publishedBrand(db, "Walton");
        queries.length = 0;

        await getPublicBrandBySlug(db, "walton");
        await listPublicBrands(db, { limit: 100 });
        await getPublicBrandSitemapEntries(db);
        await getStorefrontBrandProducts(db, brand, { page: 1, limit: 20 });
        await listBrands(db, { search: "wal" });
        await getBrandById(db, brand.id);

        expect(queries.length).toBeGreaterThan(0);
        for (const query of queries) {
            expect(query.params.length).toBeLessThanOrEqual(90);
            const plan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params)
                .map((step) => String(step.detail)).join("\n");
            expect(plan, query.sql).not.toMatch(/SCAN products\b/);
        }
        const bySlug = queries.find((query) => /"brands"\."slug" = \?/.test(query.sql));
        expect(bySlug).toBeDefined();
        const slugPlan = sqlite!.prepare(`EXPLAIN QUERY PLAN ${bySlug!.sql}`).all(...bySlug!.params)
            .map((step) => String(step.detail)).join("\n");
        expect(slugPlan).toMatch(/brands_slug_unique/);
    });
});
