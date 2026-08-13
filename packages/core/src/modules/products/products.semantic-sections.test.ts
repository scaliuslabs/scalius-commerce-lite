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
    PRODUCT_SEMANTIC_RESULT_MAX_BYTES,
    PRODUCT_SEMANTIC_TEXT_CHUNK_MAX,
    getProductSemanticSection,
    productSemanticSectionPatchSchema,
    updateProductSemanticSection,
} from "./products.semantic-sections";

type SqliteD1Result = {
    results: Record<string, SQLOutputValue>[];
    success: true;
    meta: Record<string, never>;
};

type SqliteD1Statement = D1PreparedStatement & { execute(): SqliteD1Result };

function sqliteRows(statement: StatementSync, values: SQLInputValue[]) {
    return statement.all(...values) as Record<string, SQLOutputValue>[];
}

function sqliteD1Statement(
    sqlite: DatabaseSync,
    query: string,
    values: SQLInputValue[],
    statements: string[],
): SqliteD1Statement {
    const execute = (): SqliteD1Result => {
        statements.push(query);
        const prepared = sqlite.prepare(query);
        return { results: sqliteRows(prepared, values), success: true, meta: {} };
    };
    return {
        bind: (...nextValues: unknown[]) => sqliteD1Statement(
            sqlite,
            query,
            nextValues as SQLInputValue[],
            statements,
        ),
        run: async () => execute(),
        all: async () => execute(),
        raw: async () => {
            statements.push(query);
            const prepared = sqlite.prepare(query);
            prepared.setReturnArrays(true);
            return prepared.all(...values) as unknown as SQLOutputValue[][];
        },
        first: async (column?: string) => {
            const row = execute().results[0];
            return column ? row?.[column] ?? null : row ?? null;
        },
        execute,
    } as unknown as SqliteD1Statement;
}

function createDatabase(sqlite: DatabaseSync, statements: string[]): Database {
    const binding = {
        prepare: (query: string) => sqliteD1Statement(sqlite, query, [], statements),
        async batch(batchStatements: SqliteD1Statement[]) {
            sqlite.exec("BEGIN");
            try {
                const results = batchStatements.map((statement) => statement.execute());
                sqlite.exec("COMMIT");
                return results;
            } catch (error) {
                sqlite.exec("ROLLBACK");
                throw error;
            }
        },
    } as unknown as D1Database;
    return drizzle(binding, { schema }) as unknown as Database;
}

function createSchema(sqlite: DatabaseSync) {
    sqlite.exec(`
        CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, deleted_at INTEGER);
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
        CREATE TABLE media (id TEXT PRIMARY KEY, status TEXT NOT NULL);
        CREATE TABLE product_media (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, media_id TEXT NOT NULL, alt_text TEXT,
            is_primary INTEGER NOT NULL, sort_order INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER
        );
        CREATE TABLE product_attributes (id TEXT PRIMARY KEY, deleted_at INTEGER);
        CREATE TABLE product_attribute_values (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, attribute_id TEXT NOT NULL,
            value TEXT NOT NULL, created_at INTEGER
        );
        CREATE TABLE product_rich_content (
            id TEXT PRIMARY KEY, product_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
            sort_order INTEGER NOT NULL, created_at INTEGER, updated_at INTEGER
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
    `);
}

function seedMaximumProduct(sqlite: DatabaseSync) {
    sqlite.prepare(`INSERT INTO categories(id, name) VALUES (?, ?)`).run("cat_semantic", "Semantic");
    sqlite.prepare(`INSERT INTO products VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`).run(
        "prod_semantic", "Bounded product", "d".repeat(100_000), 125,
        "cat_semantic", "bounded-product", "m".repeat(30_000), "e".repeat(40_000),
        "/products/bounded-product", 0, 0, 0, "new", 7, 1_700_000_000,
        1_700_000_001, null, 1, 10, "percentage", 0, 0, null, 1,
    );
    sqlite.prepare(`INSERT INTO product_rich_content VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "prc_semantic", "prod_semantic", "t".repeat(100_000), "c".repeat(100_000), 0, 1, 1,
    );
    sqlite.prepare(`INSERT INTO media(id, status) VALUES (?, ?), (?, ?)`).run(
        "media_semantic_primary", "ready", "media_semantic_secondary", "trashed",
    );
    sqlite.prepare(`INSERT INTO product_media VALUES (?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "pmed_semantic_primary", "prod_semantic", "media_semantic_primary", "Primary", 1, 0, 1, 1,
        "pmed_semantic_secondary", "prod_semantic", "media_semantic_secondary", "Secondary", 0, 1, 1, 1,
    );
    sqlite.prepare(`INSERT INTO product_option_definitions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "popt_size", "prod_semantic", "Size", "size", 0, "size", 1, 1, null,
    );
    const valueInsert = sqlite.prepare(`INSERT INTO product_option_values VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const variantInsert = sqlite.prepare(`INSERT INTO product_variants VALUES (
        ?, ?, ?, NULL, NULL, ?, 125, ?, 0, 0, 0, 1, 1, 1, NULL, 0, NULL, NULL,
        0, 0, NULL, 1, 0, 'percentage', 0, NULL, NULL, ?, ?, NULL
    )`);
    const selectionInsert = sqlite.prepare(`INSERT INTO product_variant_option_values VALUES (?, ?, ?)`);
    for (let index = 0; index < 150; index += 1) {
        valueInsert.run(`pval_${index}`, "popt_size", `Size ${index}`, `size ${index}`, index, 1, 1, null);
        variantInsert.run(`var_${index}`, "prod_semantic", `pval_${index}`, `SEMANTIC-${index}`, index, 100 + index, 100 + index);
        selectionInsert.run(`var_${index}`, "popt_size", `pval_${index}`);
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
        sqlite = new DatabaseSync(":memory:");
        statements = [];
        createSchema(sqlite);
        seedMaximumProduct(sqlite);
        db = createDatabase(sqlite, statements);
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
