import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { resolveCollectionProducts, resolveCollectionProductsBatch } from "./collections.service";

type QueryChain = {
    selection: Record<string, unknown>;
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    limitValue?: number;
};

function createQueryChain(selection: Record<string, unknown> = {}): QueryChain {
    const chain = { selection } as QueryChain;
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn((value: number) => {
        chain.limitValue = value;
        return chain;
    });
    chain.orderBy = vi.fn(() => chain);
    chain.get = vi.fn();
    return chain;
}

function createDb(batchResults: unknown[]): Database {
    return {
        select: vi.fn((selection: Record<string, unknown>) => createQueryChain(selection)),
        batch: vi.fn(async () => batchResults),
    } as unknown as Database;
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
            categoryIds: ["cat_a", "cat_b"],
        });

        expect(result.categories.map((category) => category.id)).toEqual([
            "cat_a",
            "cat_b",
        ]);
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
                config: { categoryIds: ["cat_large"], maxProducts: 2 },
            },
            {
                id: "larger_collection",
                config: { categoryIds: ["cat_large"], maxProducts: 5 },
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
