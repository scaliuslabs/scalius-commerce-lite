import {
    DatabaseSync,
    type SQLInputValue,
    type SQLOutputValue,
    type StatementSync,
} from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES,
    STOREFRONT_PRODUCT_TEXT_CHUNK_MAX,
    getStorefrontProductSection,
    projectStorefrontProductSection,
    type StorefrontProductDetail,
} from "./products.storefront-sections";

type SqliteD1Result = {
    results: Record<string, SQLOutputValue>[];
    success: true;
    meta: Record<string, never>;
};

type QueryProbe = {
    statements: string[];
    active: number;
    maxActive: number;
};

type SqliteD1Statement = D1PreparedStatement & { execute(): Promise<SqliteD1Result> };

function sqliteRows(statement: StatementSync, values: SQLInputValue[]) {
    return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function sqliteD1Statement(
    sqlite: DatabaseSync,
    query: string,
    values: SQLInputValue[],
    probe: QueryProbe,
): SqliteD1Statement {
    const execute = async (): Promise<SqliteD1Result> => {
        probe.statements.push(query);
        probe.active += 1;
        probe.maxActive = Math.max(probe.maxActive, probe.active);
        await Promise.resolve();
        try {
            return {
                results: sqliteRows(sqlite.prepare(query), values),
                success: true,
                meta: {},
            };
        } finally {
            probe.active -= 1;
        }
    };
    return {
        bind: (...nextValues: unknown[]) => sqliteD1Statement(
            sqlite,
            query,
            nextValues as SQLInputValue[],
            probe,
        ),
        run: execute,
        all: execute,
        raw: async () => {
            probe.statements.push(query);
            probe.active += 1;
            probe.maxActive = Math.max(probe.maxActive, probe.active);
            await Promise.resolve();
            try {
                const prepared = sqlite.prepare(query);
                prepared.setReturnArrays(true);
                return prepared.all(...values) as unknown as SQLOutputValue[][];
            } finally {
                probe.active -= 1;
            }
        },
        first: async (column?: string) => {
            const row = (await execute()).results[0];
            return column ? row?.[column] ?? null : row ?? null;
        },
        execute,
    } as unknown as SqliteD1Statement;
}

function createDatabase(sqlite: DatabaseSync, probe: QueryProbe): Database {
    const binding = {
        prepare: (query: string) => sqliteD1Statement(sqlite, query, [], probe),
        async batch(batchStatements: SqliteD1Statement[]) {
            return Promise.all(batchStatements.map((statement) => statement.execute()));
        },
    } as unknown as D1Database;
    return drizzle(binding, { schema }) as unknown as Database;
}

function createPublicSectionSchema(sqlite: DatabaseSync) {
    sqlite.exec(`
        CREATE TABLE categories (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
            status TEXT NOT NULL, deleted_at INTEGER
        );
        CREATE TABLE products (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, price REAL NOT NULL,
            category_id TEXT, slug TEXT NOT NULL, meta_title TEXT, meta_description TEXT,
            canonical_path TEXT, no_index INTEGER NOT NULL, exclude_from_sitemap INTEGER NOT NULL,
            exclude_from_product_feed INTEGER NOT NULL, product_condition TEXT,
            aggregate_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            deleted_at INTEGER, is_active INTEGER NOT NULL, discount_percentage REAL,
            discount_type TEXT, discount_amount REAL, free_delivery INTEGER NOT NULL,
            tax_class_id TEXT, tax_classification_version INTEGER NOT NULL
        );
        CREATE TABLE product_option_definitions (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, name TEXT NOT NULL, normalized_name TEXT NOT NULL,
            position INTEGER NOT NULL, standard_mapping TEXT NOT NULL, created_at INTEGER,
            updated_at INTEGER, deleted_at INTEGER
        );
        CREATE TABLE product_option_values (
            id TEXT PRIMARY KEY, option_definition_id TEXT NOT NULL, value TEXT NOT NULL,
            normalized_value TEXT NOT NULL, position INTEGER NOT NULL, created_at INTEGER,
            updated_at INTEGER, deleted_at INTEGER
        );
        CREATE TABLE product_variants (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, option_combination_key TEXT, image_id TEXT,
            weight REAL, sku TEXT NOT NULL, price REAL NOT NULL, stock INTEGER NOT NULL,
            reserved_stock INTEGER NOT NULL, preorder_stock INTEGER NOT NULL, is_default INTEGER NOT NULL,
            track_inventory INTEGER NOT NULL, version INTEGER NOT NULL, stock_version INTEGER NOT NULL,
            low_stock_threshold INTEGER, allow_preorder INTEGER NOT NULL, preorder_date TEXT,
            preorder_message TEXT, allow_backorder INTEGER NOT NULL, backorder_limit INTEGER NOT NULL,
            tax_class_id TEXT, tax_classification_version INTEGER NOT NULL, discount_percentage REAL,
            discount_type TEXT, discount_amount REAL, barcode TEXT, barcode_type TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
        );
        CREATE TABLE product_variant_option_values (
            variant_id TEXT NOT NULL, option_definition_id TEXT NOT NULL, option_value_id TEXT NOT NULL
        );
        CREATE TABLE inventory_reservation_lanes (
            variant_id TEXT NOT NULL, pool TEXT NOT NULL, lane INTEGER NOT NULL,
            reserved_quantity INTEGER NOT NULL
        );
        CREATE TABLE media (
            id TEXT PRIMARY KEY, filename TEXT NOT NULL, kind TEXT NOT NULL, object_key TEXT NOT NULL,
            size INTEGER NOT NULL, mime_type TEXT NOT NULL, alt_text TEXT, caption TEXT,
            width INTEGER, height INTEGER, duration_ms INTEGER, poster_media_id TEXT,
            folder_id TEXT, status TEXT NOT NULL, version INTEGER NOT NULL,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            trashed_at INTEGER, deleted_at INTEGER
        );
        CREATE TABLE product_media (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, media_id TEXT NOT NULL, alt_text TEXT,
            is_primary INTEGER NOT NULL, sort_order INTEGER NOT NULL,
            created_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE product_attributes (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL,
            filterable INTEGER NOT NULL, options TEXT, created_at INTEGER,
            updated_at INTEGER, deleted_at INTEGER
        );
        CREATE TABLE product_attribute_values (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, attribute_id TEXT NOT NULL,
            value TEXT NOT NULL, created_at INTEGER
        );
        CREATE TABLE product_rich_content (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, title TEXT NOT NULL,
            content TEXT NOT NULL, sort_order INTEGER NOT NULL,
            created_at INTEGER, updated_at INTEGER
        );
    `);
}

function seedPublicSectionProduct(sqlite: DatabaseSync) {
    sqlite.prepare(`INSERT INTO categories VALUES (?, ?, ?, ?, ?)`)
        .run("cat_public", "Public", "public", "published", null);
    sqlite.prepare(`INSERT INTO products VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`).run(
        "prod_public_sections", "Bounded public product", "d".repeat(100_000), 125,
        "cat_public", "bounded-public-product", "m".repeat(30_000), "e".repeat(40_000),
        "/products/bounded-public-product", 0, 0, 0, "new", 1, 1_700_000_000,
        1_700_000_001, null, 1, 10, "percentage", 0, 0, null, 1,
    );
    sqlite.prepare(`INSERT INTO product_option_definitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("popt_size", "prod_public_sections", "Size", "size", 0, "size", 1, 1, null);
    const insertValue = sqlite.prepare(
        `INSERT INTO product_option_values VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertVariant = sqlite.prepare(`INSERT INTO product_variants VALUES (
        ?, ?, ?, NULL, NULL, ?, 125, ?, 0, 0, 0, 1, 1, 1, 5, 0, NULL, NULL,
        0, 0, NULL, 1, 0, 'percentage', 0, NULL, NULL, ?, ?, NULL
    )`);
    const insertAssignment = sqlite.prepare(
        `INSERT INTO product_variant_option_values VALUES (?, ?, ?)`,
    );
    for (let index = 0; index < 150; index += 1) {
        insertValue.run(
            `pval_${index}`,
            "popt_size",
            `Size ${index}`,
            `size ${index}`,
            index,
            1,
            1,
            null,
        );
        insertVariant.run(
            `var_${index}`,
            "prod_public_sections",
            `pval_${index}`,
            `PUBLIC-${index}`,
            index === 0 ? 0 : 50,
            100 + index,
            100 + index,
        );
        insertAssignment.run(`var_${index}`, "popt_size", `pval_${index}`);
    }
}

function selectedOption(index: number) {
    return {
        optionDefinitionId: "popt_size",
        optionValueId: `pval_${index}`,
        name: "Size",
        value: `Size ${index}`,
        position: 0,
        valuePosition: index,
        standardMapping: "size" as const,
    };
}

function detailFixture(): StorefrontProductDetail {
    return {
        product: {
            id: "prod_public_sections",
            name: "Bounded public product",
            description: "d".repeat(100_000),
            price: 125,
            categoryId: "cat_public",
            slug: "bounded-public-product",
            metaTitle: "m".repeat(30_000),
            metaDescription: "e".repeat(40_000),
            canonicalPath: "/products/bounded-public-product",
            productCondition: "new",
            noIndex: false,
            discountType: "percentage",
            discountPercentage: 10,
            discountAmount: 0,
            freeDelivery: false,
            isActive: true,
            deletedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            hasVariants: true,
            imageUrl: "https://store.example/media/0.jpg",
            imageMediaId: "media_0",
            imageAlt: "Primary",
            options: [{
                id: "popt_size",
                name: "Size",
                position: 0,
                standardMapping: "size",
                values: Array.from({ length: 150 }, (_, index) => ({
                    id: `pval_${index}`,
                    value: `Size ${index}`,
                    position: index,
                })),
            }],
            features: [],
            discountedPrice: 112.5,
            attributes: Array.from({ length: 90 }, (_, index) => ({
                name: `Attribute ${index}`,
                slug: `attribute-${index}`,
                value: `Value ${index}`,
            })),
            additionalInfo: [{
                id: "prc_public",
                title: "t".repeat(100_000),
                content: "c".repeat(100_000),
            }],
        },
        category: {
            id: "cat_public",
            name: "Public",
            slug: "public",
            description: null,
            imageUrl: null,
            metaTitle: null,
            metaDescription: null,
            canonicalPath: null,
            noIndex: false,
            excludeFromSitemap: false,
        },
        media: Array.from({ length: 20 }, (_, index) => ({
            id: `pmed_${index}`,
            mediaId: `media_${index}`,
            kind: "image" as const,
            url: `https://store.example/media/${index}.jpg`,
            posterMediaId: null,
            posterUrl: null,
            altText: `Image ${index}`,
            caption: null,
            width: 800,
            height: 800,
            durationMs: null,
            isPrimary: index === 0,
            sortOrder: index,
            status: "ready" as const,
        })),
        variants: Array.from({ length: 150 }, (_, index) => ({
            id: `var_${index}`,
            productId: "prod_public_sections",
            optionCombinationKey: `pval_${index}`,
            imageId: null,
            weight: null,
            sku: `PUBLIC-${index}`,
            price: 125,
            stock: 9_999,
            reservedStock: 8_888,
            isDefault: false,
            trackInventory: true,
            lowStockThreshold: 100,
            barcode: `12345${index}`,
            barcodeType: "gtin",
            discountType: "percentage",
            discountPercentage: 0,
            discountAmount: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
            availabilityBand: index === 0 ? "out_of_stock" as const : "in_stock" as const,
            imageUrl: null,
            imageMediaId: null,
            selectedOptions: [selectedOption(index)],
        })),
        relatedProducts: [],
    };
}

function serializedBytes(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

describe("storefront product semantic sections", () => {
    it("reconstructs large buyer-visible text and SKU choices from bounded reads", () => {
        const detail = detailFixture();
        const summary = projectStorefrontProductSection(detail, "summary", { offset: 0, limit: 20 });
        expect(summary).toMatchObject({
            section: "summary",
            product: {
                textLengths: { description: 100_000 },
                counts: { variants: 150 },
            },
        });

        let description = "";
        let textOffset: number | null = 0;
        while (textOffset !== null) {
            const part = projectStorefrontProductSection(detail, "text", {
                offset: textOffset,
                limit: 20,
                field: "description",
            });
            if (part.section !== "text") throw new Error("Expected text section");
            expect(part.value.length).toBeLessThanOrEqual(STOREFRONT_PRODUCT_TEXT_CHUNK_MAX);
            expect(serializedBytes(part)).toBeLessThanOrEqual(STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES);
            description += part.value;
            textOffset = part.nextOffset;
        }
        expect(description).toBe(detail.product.description);

        const variantIds: string[] = [];
        let variantOffset: number | null = 0;
        while (variantOffset !== null) {
            const part = projectStorefrontProductSection(detail, "variants", {
                offset: variantOffset,
                limit: 50,
            });
            if (part.section !== "variants") throw new Error("Expected variants section");
            expect(serializedBytes(part)).toBeLessThanOrEqual(STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES);
            variantIds.push(...part.items.map((variant) => variant.id));
            variantOffset = part.nextOffset;
        }
        expect(variantIds).toEqual(Array.from({ length: 150 }, (_, index) => `var_${index}`));
    });

    it("exposes availability bands without exact inventory or reservation counters", () => {
        const detail = detailFixture();
        const result = projectStorefrontProductSection(detail, "variants", { offset: 0, limit: 10 });
        if (result.section !== "variants") throw new Error("Expected variants section");
        expect(result.items[0]).toMatchObject({ availabilityBand: "out_of_stock", sku: "PUBLIC-0" });
        expect(result.items[0]).not.toHaveProperty("stock");
        expect(result.items[0]).not.toHaveProperty("reservedStock");
        expect(result.items[0]).not.toHaveProperty("lowStockThreshold");
        expect(result.items[0]).not.toHaveProperty("trackInventory");
    });
});

describe("storefront product semantic section D1 queries", () => {
    let sqlite: DatabaseSync;
    let probe: QueryProbe;
    let db: Database;

    beforeEach(() => {
        sqlite = new DatabaseSync(":memory:");
        probe = { statements: [], active: 0, maxActive: 0 };
        createPublicSectionSchema(sqlite);
        seedPublicSectionProduct(sqlite);
        db = createDatabase(sqlite, probe);
    });

    afterEach(() => sqlite.close());

    it("reconstructs large text through the public eligibility query and a bounded substr read", async () => {
        let description = "";
        let offset: number | null = 0;
        let calls = 0;

        while (offset !== null) {
            const before = probe.statements.length;
            const part = await getStorefrontProductSection(
                db,
                "bounded-public-product",
                "text",
                { offset, limit: 50, field: "description" },
            );
            if (!part || part.section !== "text") throw new Error("Expected public text section");
            expect(probe.statements.length - before).toBe(2);
            expect(serializedBytes(part)).toBeLessThanOrEqual(STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES);
            expect(part.value.length).toBeLessThanOrEqual(STOREFRONT_PRODUCT_TEXT_CHUNK_MAX);
            description += part.value;
            offset = part.nextOffset;
            calls += 1;
        }

        expect(description).toBe("d".repeat(100_000));
        expect(calls).toBe(9);
        expect(probe.statements).toHaveLength(18);
        expect(probe.statements.filter((statement) => statement.toLowerCase().includes("substr")))
            .toHaveLength(9);
        expect(probe.statements.filter((statement) => statement.includes("buyer_active_sku")))
            .toHaveLength(9);
        expect(probe.statements.some((statement) => statement.includes("categories.description")))
            .toBe(false);
        expect(probe.statements.some((statement) => statement.includes("categories.meta_")))
            .toBe(false);
        expect(probe.maxActive).toBe(1);
    });

    it("pages every option value with a fixed four-statement wave", async () => {
        const values: string[] = [];
        let offset: number | null = 0;
        let calls = 0;

        while (offset !== null) {
            const before = probe.statements.length;
            const part = await getStorefrontProductSection(
                db,
                "bounded-public-product",
                "option_values",
                { offset, limit: 50, itemId: "popt_size" },
            );
            if (!part || part.section !== "option_values") {
                throw new Error("Expected public option values section");
            }
            expect(probe.statements.length - before).toBe(4);
            expect(part.items.length).toBeLessThanOrEqual(50);
            expect(serializedBytes(part)).toBeLessThanOrEqual(STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES);
            values.push(...part.items.map((item) => item.id));
            offset = part.nextOffset;
            calls += 1;
        }

        expect(values).toEqual(Array.from({ length: 150 }, (_, index) => `pval_${index}`));
        expect(calls).toBe(3);
        expect(probe.statements).toHaveLength(12);
        expect(probe.statements.filter((statement) => /from "product_option_values"/i.test(statement)))
            .toHaveLength(6);
        expect(probe.statements.filter((statement) => /from "product_option_values"[\s\S]*limit \?/i.test(statement)))
            .toHaveLength(3);
        expect(probe.maxActive).toBeGreaterThan(0);
        expect(probe.maxActive).toBeLessThanOrEqual(2);
    });

    it("reconstructs 150 public SKU choices with fixed bounded five-statement waves", async () => {
        const variantIds: string[] = [];
        let offset: number | null = 0;
        let calls = 0;

        while (offset !== null) {
            const before = probe.statements.length;
            const part = await getStorefrontProductSection(
                db,
                "bounded-public-product",
                "variants",
                { offset, limit: 50 },
            );
            if (!part || part.section !== "variants") {
                throw new Error("Expected public variants section");
            }
            expect(probe.statements.length - before).toBe(5);
            expect(part.items.length).toBeLessThanOrEqual(10);
            expect(serializedBytes(part)).toBeLessThanOrEqual(STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES);
            for (const item of part.items) {
                expect(item).not.toHaveProperty("stock");
                expect(item).not.toHaveProperty("reservedStock");
                expect(item).not.toHaveProperty("trackInventory");
            }
            variantIds.push(...part.items.map((item) => item.id));
            offset = part.nextOffset;
            calls += 1;
        }

        expect(variantIds).toEqual(Array.from({ length: 150 }, (_, index) => `var_${index}`));
        expect(calls).toBe(15);
        expect(probe.statements).toHaveLength(75);
        expect(probe.statements.filter((statement) => /from "product_variants"[\s\S]*limit \?/i.test(statement)))
            .toHaveLength(15);
        expect(probe.maxActive).toBe(2);
    });

    it("keeps summary projection compact and below the D1 six-connection ceiling", async () => {
        const summary = await getStorefrontProductSection(
            db,
            "bounded-public-product",
            "summary",
            { offset: 0, limit: 20 },
        );

        expect(summary).toMatchObject({
            section: "summary",
            product: {
                category: { id: "cat_public", name: "Public", slug: "public" },
                textLengths: { description: 100_000, metaTitle: 30_000, metaDescription: 40_000 },
                counts: { options: 1, variants: 150 },
            },
        });
        expect(serializedBytes(summary)).toBeLessThanOrEqual(STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES);
        expect(probe.statements).toHaveLength(4);
        expect(probe.maxActive).toBeGreaterThan(0);
        expect(probe.maxActive).toBeLessThanOrEqual(3);
        expect(probe.statements.some((statement) => statement.includes("categories.description")))
            .toBe(false);
        expect(probe.statements.some((statement) => statement.includes("categories.meta_")))
            .toBe(false);
    });

    it("returns no section for an unpublished product category only when product eligibility fails", async () => {
        sqlite.prepare(`UPDATE products SET is_active = 0 WHERE id = ?`).run("prod_public_sections");
        probe.statements.length = 0;

        const result = await getStorefrontProductSection(
            db,
            "bounded-public-product",
            "text",
            { offset: 0, limit: 50, field: "description" },
        );

        expect(result).toBeNull();
        expect(probe.statements).toHaveLength(1);
    });
});
