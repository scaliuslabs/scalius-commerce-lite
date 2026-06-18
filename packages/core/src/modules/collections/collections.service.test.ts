import { describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { resolveCollectionProducts } from "./collections.service";

type QueryChain = {
    from: ReturnType<typeof vi.fn>;
    where: ReturnType<typeof vi.fn>;
    limit: ReturnType<typeof vi.fn>;
    orderBy: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
};

function createQueryChain(): QueryChain {
    const chain = {} as QueryChain;
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.get = vi.fn();
    return chain;
}

function createDb(batchResults: unknown[]): Database {
    return {
        select: vi.fn(() => createQueryChain()),
        batch: vi.fn(async () => batchResults),
    } as unknown as Database;
}

function product(id: string) {
    return {
        id,
        name: `Product ${id}`,
        slug: id,
        price: 100,
        discountType: null,
        discountPercentage: null,
        discountAmount: null,
        freeDelivery: false,
        categoryId: null,
        imageUrl: null,
        imageAlt: null,
        hasVariants: false,
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
