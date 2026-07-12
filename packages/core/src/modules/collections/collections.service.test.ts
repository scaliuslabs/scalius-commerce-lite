import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import {
    createCollection,
    bulkActivateCollections,
    listCollections,
    listCollectionProductOptions,
    resolveCollectionProducts,
    resolveCollectionProductsBatch,
    updateCollection,
} from "./collections.service";

type QueryChain = {
    selection: Record<string, unknown>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    leftJoin: ReturnType<typeof vi.fn>;
    innerJoin: ReturnType<typeof vi.fn>;
    offset: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    as: ReturnType<typeof vi.fn>;
    limitValue?: number;
    offsetValue?: number;
};

function createQueryChain(selection: Record<string, unknown> = {}): QueryChain {
    const chain = { selection } as QueryChain;
    Object.assign(chain, selection);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn((value: number) => {
        chain.limitValue = value;
        return chain;
    });
    chain.orderBy = vi.fn(() => chain);
    chain.leftJoin = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.offset = vi.fn((value: number) => {
        chain.offsetValue = value;
        return chain;
    });
    chain.get = vi.fn();
    chain.as = vi.fn(() => chain);
    return chain;
}

function createDb(batchResults: unknown[]): Database & {
    batch: ReturnType<typeof vi.fn>;
} {
    return {
        select: vi.fn((selection: Record<string, unknown>) => createQueryChain(selection)),
        batch: vi.fn(async () => batchResults),
    } as unknown as Database & { batch: ReturnType<typeof vi.fn> };
}

function product(id: string, categoryId: string | null = null) {
    return {
        id,
        name: `Product ${id}`,
        slug: id,
        price: 100,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
        freeDelivery: false,
        categoryId,
        imageUrl: null,
        imageAlt: null,
        hasVariants: false,
    };
}

function createCategoryBatchDb(options: {
    categoryIds: string[];
    productsByCategoryId: Map<string, ReturnType<typeof product>[]>;
    categories: { id: string; name: string; slug: string }[];
}) {
    let categoryProductQueryIndex = 0;
    let materializedCategoryRows = 0;

    const db = {
        select: vi.fn((selection: Record<string, unknown>) => createQueryChain(selection)),
        batch: vi.fn(async (statements: QueryChain[]) =>
            statements.map((statement) => {
                if (statement.orderBy.mock.calls.length > 0) {
                    const categoryId = options.categoryIds[categoryProductQueryIndex++];
                    const sourceRows = categoryId
                        ? options.productsByCategoryId.get(categoryId) ?? []
                        : [];
                    const rows = sourceRows.slice(0, statement.limitValue ?? sourceRows.length);
                    materializedCategoryRows += rows.length;
                    return rows;
                }

                if (
                    Object.hasOwn(statement.selection, "name")
                    && Object.hasOwn(statement.selection, "slug")
                    && !Object.hasOwn(statement.selection, "price")
                ) {
                    return options.categories;
                }

                return [];
            }),
        ),
    } as unknown as Database & {
        select: ReturnType<typeof vi.fn>;
        batch: ReturnType<typeof vi.fn>;
    };

    return {
        db,
        getMaterializedCategoryRows: () => materializedCategoryRows,
    };
}

describe("resolveCollectionProducts", () => {
    it("rejects create-time collection canonical overrides before an ID route exists", async () => {
        await expect(createCollection(createDb([]), {
            name: "Summer Edit",
            presentation: "grid",
            isActive: true,
            canonicalPath: "/collections/col_1",
            noIndex: false,
            excludeFromSitemap: false,
            config: {
                source: "manual",
                categoryIds: [],
                productIds: [],
                maxProducts: 8,
            },
        })).rejects.toThrow(/blank until the collection has a saved ID route/);
    });

    it("rejects edit-time collection canonical overrides that do not match the collection ID", async () => {
        const existing = createQueryChain();
        existing.get.mockResolvedValue({
            id: "V1StGXR8_Z5jdHi6B-myT",
            version: 1,
            isActive: false,
            config: JSON.stringify({ source: "manual", productIds: [], categoryIds: [] }),
        });
        const db = {
            select: vi.fn(() => existing),
            update: vi.fn(),
        } as unknown as Database;

        await expect(updateCollection(db, "V1StGXR8_Z5jdHi6B-myT", {
            expectedVersion: 1,
            canonicalPath: "/collections/Z9StGXR8_Z5jdHi6B-myT",
        })).rejects.toThrow(/must match this collection's ID route/);
        expect(db.update).not.toHaveBeenCalled();
    });

    it("rejects an edit made from a stale collection version", async () => {
        const existing = createQueryChain();
        existing.get.mockResolvedValue({
            id: "col_1",
            version: 4,
            isActive: false,
            config: JSON.stringify({ source: "manual", productIds: [], categoryIds: [] }),
        });
        const db = {
            select: vi.fn(() => existing),
            update: vi.fn(),
        } as unknown as Database;

        await expect(updateCollection(db, "col_1", {
            expectedVersion: 3,
            name: "Updated name",
            canonicalPath: undefined,
        })).rejects.toThrow(/changed while you were editing/);
        expect(db.update).not.toHaveBeenCalled();
    });

    it("keeps manually configured product order and maxProducts stable", async () => {
        const db = createDb([
            [product("p1"), product("p2"), product("p3")],
            [],
        ]);

        const result = await resolveCollectionProducts(db, {
            productIds: ["missing_or_hidden", "p3", "p1", "p2"],
            maxProducts: 2,
        });

        expect(result.products.map((item) => item.id)).toEqual(["p3", "p1"]);
    });

    it("keeps category metadata in configured category order", async () => {
        const db = createDb([
            [
                { id: "cat_b", name: "B", slug: "b" },
                { id: "cat_a", name: "A", slug: "a" },
            ],
            [],
            [],
        ]);

        const result = await resolveCollectionProducts(db, {
            source: "dynamic",
            categoryIds: ["cat_a", "cat_b"],
        });

        expect(result.categories.map((category) => category.id)).toEqual([
            "cat_a",
            "cat_b",
        ]);
    });

    it("uses the explicit content source when stale selections exist", async () => {
        const db = createDb([
            [{ id: "cat_a", name: "A", slug: "a" }],
            [product("category_product", "cat_a")],
            [],
        ]);

        const result = await resolveCollectionProducts(db, {
            source: "dynamic",
            categoryIds: ["cat_a"],
            productIds: ["stale_manual_product"],
        });

        expect(result.products.map((item) => item.id)).toEqual(["category_product"]);
        expect(result.categories.map((item) => item.id)).toEqual(["cat_a"]);
    });
});

describe("listCollectionProductOptions", () => {
    it("returns stable paginated summaries from one bounded batch", async () => {
        const rows = [
            {
                id: "prod_a",
                name: "Alpha",
                price: 100,
                categoryId: "cat_a",
                categoryName: "Category A",
                isActive: true,
            },
        ];
        const db = createDb([[{ count: 21 }], rows]);

        const result = await listCollectionProductOptions(db, {
            page: 2,
            limit: 10,
            search: "alpha",
            categoryIds: [
                ...Array.from({ length: 95 }, (_, index) => `cat_${index}`),
                "cat_1",
            ],
        });

        expect(result).toEqual({
            products: rows,
            pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
        });
        expect(db.batch).toHaveBeenCalledTimes(1);
        const statements = db.batch.mock.calls[0]?.[0] as QueryChain[];
        expect(statements).toHaveLength(2);
        expect(statements[1]?.limit).toHaveBeenCalledWith(10);
        expect(statements[1]?.offset).toHaveBeenCalledWith(10);
    });
});

describe("listCollections", () => {
    it("normalizes pagination and reads count plus rows in one bounded batch", async () => {
        const rows = [{ id: "col_1", name: "One", version: 1 }];
        const db = createDb([[{ count: 1 }], rows]);

        const result = await listCollections(db, { page: -5, limit: 500 });

        expect(result.pagination).toEqual({ page: 1, limit: 100, total: 1, totalPages: 1 });
        expect(result.collections).toEqual(rows);
        expect(db.batch).toHaveBeenCalledTimes(1);
        const statements = db.batch.mock.calls[0]?.[0] as QueryChain[];
        expect(statements).toHaveLength(2);
        expect(statements[1]?.limit).toHaveBeenCalledWith(100);
        expect(statements[1]?.offset).toHaveBeenCalledWith(0);
    });
});

describe("bulkActivateCollections", () => {
    it("validates all membership references with one product read and one category read", async () => {
        const rows = [
            {
                id: "col_manual",
                version: 1,
                config: JSON.stringify({ source: "manual", productIds: ["prod_1"] }),
            },
            {
                id: "col_dynamic",
                version: 3,
                config: JSON.stringify({ source: "dynamic", categoryIds: ["cat_1"], featuredProductId: "prod_2" }),
            },
        ];
        const selectedRows = [
            rows,
            [{ id: "prod_1" }, { id: "prod_2" }],
            [{ id: "cat_1", status: "published" }],
        ];
        const select = vi.fn(() => {
            const result = selectedRows.shift() ?? [];
            const chain: Record<string, unknown> = {};
            chain.from = vi.fn(() => chain);
            chain.where = vi.fn(() => chain);
            chain.all = vi.fn(async () => result);
            return chain;
        });
        const update = vi.fn(() => {
            const chain: Record<string, unknown> = {};
            chain.set = vi.fn(() => chain);
            chain.where = vi.fn(() => chain);
            chain.returning = vi.fn(() => chain);
            return chain;
        });
        const db = {
            select,
            update,
            batch: vi.fn(async () => [[{ id: "col_manual" }], [{ id: "col_dynamic" }]]),
        } as unknown as Database;

        await bulkActivateCollections(db, ["col_manual", "col_dynamic"]);

        expect(select).toHaveBeenCalledTimes(3);
        expect(update).toHaveBeenCalledTimes(2);
    });

    it("distinguishes unpublished categories from missing references", async () => {
        const rows = [{
            id: "col_dynamic",
            version: 3,
            config: JSON.stringify({ source: "dynamic", categoryIds: ["cat_draft"] }),
        }];
        const selectedRows = [rows, [{ id: "cat_draft", status: "draft" }]];
        const select = vi.fn(() => {
            const result = selectedRows.shift() ?? [];
            const chain: Record<string, unknown> = {};
            chain.from = vi.fn(() => chain);
            chain.where = vi.fn(() => chain);
            chain.all = vi.fn(async () => result);
            return chain;
        });
        const db = { select } as unknown as Database;

        await expect(bulkActivateCollections(db, ["col_dynamic"]))
            .rejects.toThrow(/Publish the selected categories/i);
    });
});

describe("resolveCollectionProductsBatch", () => {
    it("bounds shared category-backed product queries by the largest requested maxProducts", async () => {
        const largeCategoryProducts = Array.from({ length: 50 }, (_, index) =>
            product(`cat_large_${index}`, "cat_large"),
        );
        const { db, getMaterializedCategoryRows } = createCategoryBatchDb({
            categoryIds: ["cat_large"],
            productsByCategoryId: new Map([["cat_large", largeCategoryProducts]]),
            categories: [{ id: "cat_large", name: "Large", slug: "large" }],
        });

        const result = await resolveCollectionProductsBatch(db, [
            {
                id: "small_collection",
                config: { source: "dynamic", categoryIds: ["cat_large"], maxProducts: 2 },
            },
            {
                id: "larger_collection",
                config: { source: "dynamic", categoryIds: ["cat_large"], maxProducts: 5 },
            },
        ]);

        expect(result.get("small_collection")?.products.map((item) => item.id)).toEqual([
            "cat_large_0",
            "cat_large_1",
        ]);
        expect(result.get("larger_collection")?.products.map((item) => item.id)).toEqual([
            "cat_large_0",
            "cat_large_1",
            "cat_large_2",
            "cat_large_3",
            "cat_large_4",
        ]);
        expect(getMaterializedCategoryRows()).toBe(5);

        const batchStatements = db.batch.mock.calls[0]?.[0] as QueryChain[];
        const categoryProductStatements = batchStatements.filter(
            (statement) => statement.orderBy.mock.calls.length > 0,
        );

        expect(categoryProductStatements).toHaveLength(1);
        expect(categoryProductStatements[0]?.limit).toHaveBeenCalledWith(5);
    });
});
