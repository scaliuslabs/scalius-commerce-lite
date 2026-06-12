import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@scalius/database/client";
import { NotFoundError } from "@scalius/core/errors";

const mocks = vi.hoisted(() => ({
    getPublicCategoryById: vi.fn(),
    getStorefrontProducts: vi.fn(),
}));

vi.mock("../categories/categories.storefront", () => ({
    getPublicCategoryById: mocks.getPublicCategoryById,
}));

vi.mock("../products/products.storefront", () => ({
    getStorefrontProducts: mocks.getStorefrontProducts,
}));

import { getNavigationPreviewProductCount } from "./navigation.service";

describe("navigation preview product count", () => {
    const db = {} as Database;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("uses storefront product filters so preview counts match public category pages", async () => {
        mocks.getPublicCategoryById.mockResolvedValue({ id: "cat_1" });
        mocks.getStorefrontProducts.mockResolvedValue({
            products: [],
            pagination: { total: 12, page: 1, limit: 1, totalPages: 12 },
        });

        const result = await getNavigationPreviewProductCount(db, {
            categoryId: "cat_1",
            search: "shirt",
            minPrice: 10,
            maxPrice: 100,
            freeDelivery: "true",
            hasDiscount: "false",
            attributeFilters: [{ slug: "color", value: "Blue" }],
        });

        expect(result).toEqual({ count: 12 });
        expect(mocks.getStorefrontProducts).toHaveBeenCalledWith(db, {
            category: "cat_1",
            search: "shirt",
            minPrice: 10,
            maxPrice: 100,
            freeDelivery: "true",
            hasDiscount: "false",
            page: 1,
            limit: 1,
            sort: "newest",
            attributeFilters: [{ slug: "color", value: "Blue" }],
        });
    });

    it("rejects missing or deleted public categories before counting products", async () => {
        mocks.getPublicCategoryById.mockResolvedValue(null);

        await expect(
            getNavigationPreviewProductCount(db, { categoryId: "cat_deleted" }),
        ).rejects.toBeInstanceOf(NotFoundError);
        expect(mocks.getStorefrontProducts).not.toHaveBeenCalled();
    });
});
