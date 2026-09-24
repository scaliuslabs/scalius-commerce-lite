import type { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/d1";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createMigratedSqlite, createSqliteD1Binding } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    STOREFRONT_PRODUCT_SECTION_RESULT_MAX_BYTES,
    STOREFRONT_PRODUCT_TEXT_CHUNK_MAX,
    getStorefrontProductSection,
    projectStorefrontProductSection,
    type StorefrontProductDetail,
} from "./products.storefront-sections";

type QueryProbe = {
    statements: string[];
    active: number;
    maxActive: number;
};

type StatementRead = "all" | "raw" | "run" | "first";

/** Counts overlapping statement reads so tests can hold the D1 six-connection ceiling. */
function createDatabase(sqlite: DatabaseSync, probe: QueryProbe): Database {
    const binding = createSqliteD1Binding(sqlite, { onQuery: (query) => probe.statements.push(query) });
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const tracked = (method: StatementRead) => async (...args: unknown[]) => {
            probe.active += 1;
            probe.maxActive = Math.max(probe.maxActive, probe.active);
            await Promise.resolve();
            try {
                return await Reflect.apply(statement[method], statement, args);
            } finally {
                probe.active -= 1;
            }
        };
        return {
            ...statement,
            bind: (...values: unknown[]) => wrap(statement.bind(...values)),
            all: tracked("all"),
            raw: tracked("raw"),
            run: tracked("run"),
            first: tracked("first"),
        } as D1PreparedStatement;
    };
    const probed = { ...binding, prepare: (query: string) => wrap(binding.prepare(query)) };
    return drizzle(probed as D1Database, { schema }) as unknown as Database;
}

function seedPublicSectionProduct(sqlite: DatabaseSync) {
    sqlite.prepare(`INSERT INTO categories (id, name, slug, status) VALUES (?, ?, ?, ?)`)
        .run("cat_public", "Public", "public", "published");
    sqlite.prepare(`INSERT INTO products (
        id, name, description, price_minor, category_id, slug, meta_title, meta_description,
        canonical_path, product_condition, created_at, updated_at,
        discount_bps, discount_type, discount_amount_minor
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "prod_public_sections", "Bounded public product", "d".repeat(100_000), 12_500,
        "cat_public", "bounded-public-product", "m".repeat(30_000), "e".repeat(40_000),
        "/products/bounded-public-product", "new", 1_700_000_000, 1_700_000_001, 1_000, "percentage", 0,
    );
    sqlite.prepare(`INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
        VALUES (?, ?, ?, ?, ?, ?)`).run("popt_size", "prod_public_sections", "Size", "size", 0, "size");
    const insertValue = sqlite.prepare(`INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position)
        VALUES (?, 'popt_size', ?, ?, ?)`);
    const insertVariant = sqlite.prepare(`INSERT INTO product_variants (
        id, product_id, option_combination_key, sku, price_minor, stock, low_stock_threshold,
        discount_type, discount_bps, created_at, updated_at
    ) VALUES (?, 'prod_public_sections', ?, ?, 12500, ?, 5, 'percentage', 0, ?, ?)`);
    const insertAssignment = sqlite.prepare(`INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id)
        VALUES (?, 'popt_size', ?)`);
    for (let index = 0; index < 150; index += 1) {
        insertValue.run(`pval_${index}`, `Size ${index}`, `size ${index}`, index);
        insertVariant.run(
            `var_${index}`,
            `pval_${index}`,
            `PUBLIC-${index}`,
            index === 0 ? 0 : 50,
            100 + index,
            100 + index,
        );
        insertAssignment.run(`var_${index}`, `pval_${index}`);
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
            filename: `image-${index}.jpg`,
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
        recommendations: { products: [] },
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
        sqlite = createMigratedSqlite();
        probe = { statements: [], active: 0, maxActive: 0 };
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
