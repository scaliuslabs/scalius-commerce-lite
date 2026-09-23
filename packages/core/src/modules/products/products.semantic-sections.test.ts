import type { DatabaseSync } from "node:sqlite";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    PRODUCT_SEMANTIC_RESULT_MAX_BYTES,
    PRODUCT_SEMANTIC_TEXT_CHUNK_MAX,
    getProductSemanticSection,
    productSemanticSectionPatchSchema,
    updateProductSemanticSection,
} from "./products.semantic-sections";

function seedMaximumProduct(sqlite: DatabaseSync) {
    sqlite.prepare(`INSERT INTO categories(id, name, slug) VALUES (?, ?, ?)`).run("cat_semantic", "Semantic", "semantic");
    sqlite.prepare(`INSERT INTO products (
        id, name, description, price, category_id, slug, meta_title, meta_description,
        canonical_path, product_condition, aggregate_revision, created_at, updated_at,
        discount_percentage, discount_type, discount_amount
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "prod_semantic", "Bounded product", "d".repeat(100_000), 125,
        "cat_semantic", "bounded-product", "m".repeat(30_000), "e".repeat(40_000),
        "/products/bounded-product", "new", 7, 1_700_000_000, 1_700_000_001, 10, "percentage", 0,
    );
    sqlite.prepare(`INSERT INTO product_rich_content (id, product_id, title, content, sort_order) VALUES (?, ?, ?, ?, ?)`).run(
        "prc_semantic", "prod_semantic", "t".repeat(100_000), "c".repeat(100_000), 0,
    );
    sqlite.prepare(`INSERT INTO media (id, filename, kind, object_key, size, mime_type, status) VALUES
        (?, 'primary.webp', 'image', 'media/primary.webp', 1, 'image/webp', 'ready'),
        (?, 'secondary.webp', 'image', 'media/secondary.webp', 1, 'image/webp', 'ready')`).run(
        "media_semantic_primary", "media_semantic_secondary",
    );
    sqlite.prepare(`INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order) VALUES
        (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`).run(
        "pmed_semantic_primary", "prod_semantic", "media_semantic_primary", "Primary", 1, 0,
        "pmed_semantic_secondary", "prod_semantic", "media_semantic_secondary", "Secondary", 0, 1,
    );
    sqlite.prepare(`UPDATE media SET status = 'trashed', trashed_at = 1 WHERE id = ?`).run("media_semantic_secondary");
    sqlite.prepare(`INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
        VALUES (?, ?, ?, ?, ?, ?)`).run("popt_size", "prod_semantic", "Size", "size", 0, "size");
    const valueInsert = sqlite.prepare(`INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position)
        VALUES (?, 'popt_size', ?, ?, ?)`);
    const variantInsert = sqlite.prepare(`INSERT INTO product_variants (
        id, product_id, option_combination_key, sku, price, stock, discount_type, discount_percentage, created_at, updated_at
    ) VALUES (?, 'prod_semantic', ?, ?, 125, ?, 'percentage', 0, ?, ?)`);
    const selectionInsert = sqlite.prepare(`INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id) VALUES (?, 'popt_size', ?)`);
    for (let index = 0; index < 150; index += 1) {
        valueInsert.run(`pval_${index}`, `Size ${index}`, `size ${index}`, index);
        variantInsert.run(`var_${index}`, `pval_${index}`, `SEMANTIC-${index}`, index, 100 + index, 100 + index);
        selectionInsert.run(`var_${index}`, `pval_${index}`);
    }
}

function serializedBytes(value: unknown) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const query = (offset = 0, limit = 50) => ({ offset, limit });

describe("product semantic sections", () => {
    let sqlite: DatabaseSync;
    let statements: string[];
    let db: Database;

    beforeEach(() => {
        statements = [];
        ({ sqlite, db } = createSqliteD1Database({ onQuery: (statement) => statements.push(statement) }));
        seedMaximumProduct(sqlite);
    });

    afterEach(() => sqlite.close());

    it("reconstructs 100k text and 150 SKUs using constant bounded queries per call", async () => {
        const base = await getProductSemanticSection(db, "prod_semantic", "base", query());
        expect(base).toMatchObject({
            section: "base",
            aggregateRevision: 7,
            product: { textLengths: { description: 100_000 }, counts: { variants: 150 } },
        });
        expect(serializedBytes(base)).toBeLessThanOrEqual(PRODUCT_SEMANTIC_RESULT_MAX_BYTES);
        expect(JSON.stringify(base)).not.toContain("d".repeat(PRODUCT_SEMANTIC_TEXT_CHUNK_MAX));

        statements.length = 0;
        let description = "";
        let textOffset: number | null = 0;
        let textCalls = 0;
        while (textOffset !== null) {
            const before = statements.length;
            const part = await getProductSemanticSection(db, "prod_semantic", "text", {
                ...query(textOffset), field: "description",
            });
            if (!part || part.section !== "text") throw new Error("Expected text");
            expect(statements.length - before).toBe(1);
            expect(serializedBytes(part)).toBeLessThanOrEqual(PRODUCT_SEMANTIC_RESULT_MAX_BYTES);
            description += part.value;
            textOffset = part.nextOffset;
            textCalls += 1;
        }
        expect(description).toBe("d".repeat(100_000));
        expect(textCalls).toBe(9);
        expect(statements).toHaveLength(9);
        expect(statements.every((statement) => statement.toLowerCase().includes("substr"))).toBe(true);

        statements.length = 0;
        const variantIds: string[] = [];
        let variantOffset: number | null = 0;
        let variantCalls = 0;
        while (variantOffset !== null) {
            const before = statements.length;
            const part = await getProductSemanticSection(db, "prod_semantic", "variants", query(variantOffset));
            if (!part || part.section !== "variants") throw new Error("Expected variants");
            expect(part.total, statements.at(before)).toBe(150);
            expect(statements.length - before).toBe(3);
            expect(part.items.length).toBeLessThanOrEqual(10);
            expect(serializedBytes(part)).toBeLessThanOrEqual(PRODUCT_SEMANTIC_RESULT_MAX_BYTES);
            variantIds.push(...part.items.map((item) => item.id));
            variantOffset = part.nextOffset;
            variantCalls += 1;
        }
        expect(variantIds).toEqual(Array.from({ length: 150 }, (_, index) => `var_${index}`));
        expect(variantCalls).toBe(15);
        expect(statements).toHaveLength(45);
        expect(statements.filter((statement) => /limit \?/i.test(statement))).toHaveLength(15);
    });

    it("reads the bounded media section through object-shaped D1 results", async () => {
        const result = await getProductSemanticSection(db, "prod_semantic", "media", query(0, 20));

        expect(result).toMatchObject({
            section: "media",
            aggregateRevision: 7,
            total: 2,
            offset: 0,
            limit: 20,
            nextOffset: null,
            items: [
                { id: "pmed_semantic_primary", mediaId: "media_semantic_primary", isPrimary: true },
                { id: "pmed_semantic_secondary", mediaId: "media_semantic_secondary", isPrimary: false },
            ],
        });
        expect(statements).toHaveLength(2);
        expect(statements[0]).toContain('ON "media"."id" = "product_media"."media_id"');
        expect(serializedBytes(result)).toBeLessThanOrEqual(PRODUCT_SEMANTIC_RESULT_MAX_BYTES);
    });

    it("updates only the requested text column and bumps the aggregate once", async () => {
        await expect(updateProductSemanticSection(db, "prod_semantic", {
            section: "text",
            field: "description",
            offset: 0,
            deleteCount: 100_000,
            value: "A newly edited product description.",
            expectedAggregateRevision: 7,
        })).resolves.toEqual({ aggregateRevision: 8 });

        const row = sqlite.prepare(`SELECT description, meta_title, aggregate_revision FROM products WHERE id = ?`).get("prod_semantic") as Record<string, unknown>;
        expect(row.description).toBe("A newly edited product description.");
        expect(row.meta_title).toBe("m".repeat(30_000));
        expect(row.aggregate_revision).toBe(8);
    });

    it("preserves nullable legacy category and condition on an unrelated base edit", async () => {
        sqlite.prepare(`UPDATE products SET category_id = NULL, product_condition = NULL WHERE id = ?`).run("prod_semantic");
        await updateProductSemanticSection(db, "prod_semantic", {
            section: "base",
            patch: { name: "Categoryless product" },
            expectedAggregateRevision: 7,
        });
        const row = sqlite.prepare(`SELECT name, category_id, product_condition FROM products WHERE id = ?`).get("prod_semantic") as Record<string, unknown>;
        expect(row).toMatchObject({ name: "Categoryless product", category_id: null, product_condition: null });
    });

    it("replaces 100k text through nine sub-16KiB revision-guarded writes", async () => {
        const replacement = "r".repeat(100_000);
        let written = 0;
        let expectedAggregateRevision = 7;
        let writes = 0;
        while (written < replacement.length) {
            const value = replacement.slice(written, written + PRODUCT_SEMANTIC_TEXT_CHUNK_MAX);
            const patch = {
                section: "text" as const,
                field: "description" as const,
                offset: written,
                deleteCount: written === 0 ? 100_000 : 0,
                value,
                expectedAggregateRevision,
            };
            expect(serializedBytes(patch)).toBeLessThan(16 * 1024);
            const result = await updateProductSemanticSection(db, "prod_semantic", patch);
            expectedAggregateRevision = result!.aggregateRevision;
            written += value.length;
            writes += 1;
        }
        const row = sqlite.prepare(`SELECT description, aggregate_revision FROM products WHERE id = ?`).get("prod_semantic") as Record<string, unknown>;
        expect(row.description).toBe(replacement);
        expect(row.aggregate_revision).toBe(16);
        expect(writes).toBe(9);
    });

    it("returns null for a missing product and reports a stale revision as 409 without retry", async () => {
        await expect(getProductSemanticSection(db, "missing", "base", query())).resolves.toBeNull();
        await expect(updateProductSemanticSection(db, "missing", {
            section: "base",
            patch: { name: "Missing product" },
            expectedAggregateRevision: 1,
        })).resolves.toBeNull();

        statements.length = 0;
        await expect(updateProductSemanticSection(db, "prod_semantic", {
            section: "base",
            patch: { name: "Stale edit" },
            expectedAggregateRevision: 6,
        })).rejects.toMatchObject({
            status: 409,
            code: "PRODUCT_REVISION_CONFLICT",
            details: { expectedRevision: 6, currentRevision: 7 },
        });
        expect(sqlite.prepare(`SELECT name, aggregate_revision FROM products WHERE id = ?`).get("prod_semantic")).toMatchObject({
            name: "Bounded product",
            aggregate_revision: 7,
        });
        expect(statements.filter((statement) => statement.includes("batch_guard_source"))).toHaveLength(1);
        expect(statements.filter((statement) => /^update .*products/i.test(statement))).toHaveLength(0);
    });

    it("rejects text request bodies over the reviewed 12k value bound", () => {
        expect(productSemanticSectionPatchSchema.safeParse({
            section: "text",
            field: "description",
            offset: 0,
            deleteCount: 0,
            value: "x".repeat(PRODUCT_SEMANTIC_TEXT_CHUNK_MAX + 1),
            expectedAggregateRevision: 7,
        }).success).toBe(false);
    });
});
